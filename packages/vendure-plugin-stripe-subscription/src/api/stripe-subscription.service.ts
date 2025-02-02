import { Injectable } from '@nestjs/common';
import { StockMovementType } from '@vendure/common/lib/generated-types';
import {
  ActiveOrderService,
  Channel,
  ChannelService,
  CustomerService,
  EntityHydrator,
  ErrorResult,
  EventBus,
  HistoryService,
  ID,
  InternalServerError,
  JobQueue,
  JobQueueService,
  LanguageCode,
  ListQueryBuilder,
  ListQueryOptions,
  Logger,
  Order,
  OrderLine,
  OrderLineEvent,
  OrderService,
  OrderStateTransitionError,
  PaginatedList,
  PaymentMethod,
  PaymentMethodService,
  ProductVariantService,
  RequestContext,
  SerializedRequestContext,
  StockMovementEvent,
  TransactionalConnection,
  UserInputError,
} from '@vendure/core';
import { loggerCtx } from '../constants';
import { IncomingStripeWebhook } from './types/stripe.types';
import {
  CustomerWithSubscriptionFields,
  OrderLineWithSubscriptionFields,
  OrderWithSubscriptionFields,
  VariantWithSubscriptionFields,
} from './subscription-custom-fields';
import { StripeClient } from './stripe.client';
import {
  StripeSubscriptionPaymentList,
  StripeSubscriptionPaymentListOptions,
  StripeSubscriptionPricing,
  StripeSubscriptionPricingInput,
} from '../ui/generated/graphql';
import { stripeSubscriptionHandler } from './stripe-subscription.handler';
import { Request } from 'express';
import { filter } from 'rxjs/operators';
import {
  calculateSubscriptionPricing,
  applySubscriptionPromotions,
  getNextCyclesStartDate,
  printMoney,
} from './pricing.helper';
import { Cancellation } from '@vendure/core/dist/entity/stock-movement/cancellation.entity';
import { Release } from '@vendure/core/dist/entity/stock-movement/release.entity';
import { randomUUID } from 'crypto';
import { hasSubscriptions } from './has-stripe-subscription-products-payment-checker';
import { StripeSubscriptionPayment } from './stripe-subscription-payment.entity';
import { StripeInvoice } from './types/stripe-invoice';
import { StripePaymentIntent } from './types/stripe-payment-intent';
import Stripe from 'stripe';

export interface StripeContext {
  paymentMethod: PaymentMethod;
  stripeClient: StripeClient;
}

interface CreateSubscriptionsJob {
  action: 'createSubscriptionsForOrder';
  ctx: SerializedRequestContext;
  orderCode: string;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
}

interface CancelSubscriptionsJob {
  action: 'cancelSubscriptionsForOrderline';
  ctx: SerializedRequestContext;
  orderLineId: ID;
}

export type JobData = CreateSubscriptionsJob | CancelSubscriptionsJob;

@Injectable()
export class StripeSubscriptionService {
  constructor(
    private paymentMethodService: PaymentMethodService,
    private activeOrderService: ActiveOrderService,
    private variantService: ProductVariantService,
    private entityHydrator: EntityHydrator,
    private channelService: ChannelService,
    private orderService: OrderService,
    private listQueryBuilder: ListQueryBuilder,
    private historyService: HistoryService,
    private eventBus: EventBus,
    private jobQueueService: JobQueueService,
    private customerService: CustomerService,
    private connection: TransactionalConnection
  ) {}

  private jobQueue!: JobQueue<JobData>;

  async onModuleInit() {
    // Create jobQueue with handlers
    this.jobQueue = await this.jobQueueService.createQueue({
      name: 'stripe-subscription',
      process: async ({ data, id }) => {
        const ctx = RequestContext.deserialize(data.ctx);
        if (data.action === 'cancelSubscriptionsForOrderline') {
          this.cancelSubscriptionForOrderLine(ctx, data.orderLineId);
        } else if (data.action === 'createSubscriptionsForOrder') {
          const order = await this.orderService.findOneByCode(
            ctx,
            data.orderCode,
            []
          );
          try {
            await this.createSubscriptions(
              ctx,
              data.orderCode,
              data.stripeCustomerId,
              data.stripePaymentMethodId
            );
          } catch (error) {
            Logger.warn(
              `Failed to process job ${data.action} (${id}) for channel ${data.ctx._channel.token}: ${error}`,
              loggerCtx
            );
            if (order) {
              await this.logHistoryEntry(
                ctx,
                order.id,
                'Failed to create subscription',
                error
              );
            }
            throw error;
          }
        }
      },
    });
    // Add unique hash for subscriptions, so Vendure creates a new order line
    this.eventBus.ofType(OrderLineEvent).subscribe(async (event) => {
      const orderLine = event.orderLine as OrderLineWithSubscriptionFields;
      if (
        event.type === 'created' &&
        orderLine.productVariant.customFields.subscriptionSchedule
      ) {
        await this.connection
          .getRepository(event.ctx, OrderLine)
          .update(
            { id: event.orderLine.id },
            { customFields: { subscriptionHash: randomUUID() } }
          );
      }
    });
    // Listen for stock cancellation or release events
    this.eventBus
      .ofType(StockMovementEvent)
      .pipe(
        // Filter by event type
        filter(
          (event) =>
            event.type === StockMovementType.RELEASE ||
            event.type === StockMovementType.CANCELLATION
        )
      )
      .subscribe(async (event) => {
        const orderLinesWithSubscriptions = (
          event.stockMovements as (Cancellation | Release)[]
        )
          .map(
            (stockMovement) =>
              stockMovement.orderLine as OrderLineWithSubscriptionFields
          )
          // Filter out non-sub orderlines
          .filter((orderLine) => orderLine.customFields.subscriptionIds);
        await Promise.all(
          // Push jobs
          orderLinesWithSubscriptions.map((line) =>
            this.jobQueue.add({
              ctx: event.ctx.serialize(),
              action: 'cancelSubscriptionsForOrderline',
              orderLineId: line.id,
            })
          )
        );
      });
  }

  async cancelSubscriptionForOrderLine(
    ctx: RequestContext,
    orderLineId: ID
  ): Promise<void> {
    const order = (await this.orderService.findOneByOrderLineId(
      ctx,
      orderLineId,
      ['lines']
    )) as OrderWithSubscriptionFields | undefined;
    if (!order) {
      throw Error(`Order for OrderLine ${orderLineId} not found`);
    }
    const line = order?.lines.find((l) => l.id == orderLineId);
    if (!line?.customFields.subscriptionIds?.length) {
      return Logger.info(
        `OrderLine ${orderLineId} of ${orderLineId} has no subscriptionIds. Not cancelling anything... `,
        loggerCtx
      );
    }
    await this.entityHydrator.hydrate(ctx, line, { relations: ['order'] });
    const { stripeClient } = await this.getStripeContext(ctx);
    for (const subscriptionId of line.customFields.subscriptionIds) {
      try {
        await stripeClient.subscriptions.update(subscriptionId, {
          cancel_at_period_end: true,
        });
        Logger.info(`Cancelled subscription ${subscriptionId}`);
        await this.logHistoryEntry(
          ctx,
          order!.id,
          `Cancelled subscription ${subscriptionId}`,
          undefined,
          undefined,
          subscriptionId
        );
      } catch (e: unknown) {
        Logger.error(
          `Failed to cancel subscription ${subscriptionId}`,
          loggerCtx
        );
        await this.logHistoryEntry(
          ctx,
          order.id,
          `Failed to cancel ${subscriptionId}`,
          e,
          undefined,
          subscriptionId
        );
      }
    }
  }

  /**
   * Proxy to Stripe to retrieve subscriptions created for the current channel.
   * Proxies to the Stripe api, so you can use the same filtering, parameters and options as defined here
   * https://stripe.com/docs/api/subscriptions/list
   */
  async getAllSubscriptions(
    ctx: RequestContext,
    params?: Stripe.SubscriptionListParams,
    options?: Stripe.RequestOptions
  ): Promise<Stripe.ApiListPromise<Stripe.Subscription>> {
    const { stripeClient } = await this.getStripeContext(ctx);
    return stripeClient.subscriptions.list(params, options);
  }

  /**
   * Get a subscription directly from Stripe
   */
  async getSubscription(
    ctx: RequestContext,
    subscriptionId: string
  ): Promise<Stripe.Response<Stripe.Subscription>> {
    const { stripeClient } = await this.getStripeContext(ctx);
    return stripeClient.subscriptions.retrieve(subscriptionId);
  }

  async createPaymentIntent(ctx: RequestContext): Promise<string> {
    let order = (await this.activeOrderService.getActiveOrder(
      ctx,
      undefined
    )) as OrderWithSubscriptionFields;
    if (!order) {
      throw new UserInputError('No active order for session');
    }
    if (!order.totalWithTax) {
      // Add a verification fee to the order to support orders that are actually $0
      order = (await this.orderService.addSurchargeToOrder(ctx, order.id, {
        description: 'Verification fee',
        listPrice: 100,
        listPriceIncludesTax: true,
      })) as OrderWithSubscriptionFields;
    }
    await this.entityHydrator.hydrate(ctx, order, {
      relations: ['customer', 'shippingLines', 'lines.productVariant'],
    });
    if (!order.lines?.length) {
      throw new UserInputError('Cannot create payment intent for empty order');
    }
    if (!order.customer) {
      throw new UserInputError(
        'Cannot create payment intent for order without customer'
      );
    }
    if (!order.shippingLines?.length) {
      throw new UserInputError(
        'Cannot create payment intent for order without shippingMethod'
      );
    }
    // Check if Stripe Subscription paymentMethod is eligible for this order
    const eligibleStripeMethodCodes = (
      await this.orderService.getEligiblePaymentMethods(ctx, order.id)
    )
      .filter((m) => m.isEligible)
      .map((m) => m.code);
    const { stripeClient, paymentMethod } = await this.getStripeContext(ctx);
    if (!eligibleStripeMethodCodes.includes(paymentMethod.code)) {
      throw new UserInputError(
        `No eligible payment method found with code \'stripe-subscription\'`
      );
    }
    const stripeCustomer = await stripeClient.getOrCreateCustomer(
      order.customer
    );
    this.customerService
      .update(ctx, {
        id: order.customer.id,
        customFields: {
          stripeSubscriptionCustomerId: stripeCustomer.id,
        },
      })
      .catch((err) =>
        Logger.error(
          `Failed to update stripeCustomerId ${stripeCustomer.id} for ${order.customer.emailAddress}`,
          loggerCtx,
          err
        )
      );
    const hasSubscriptionProducts = order.lines.some(
      (l) => l.productVariant.customFields.subscriptionSchedule
    );
    const intent = await stripeClient.paymentIntents.create({
      customer: stripeCustomer.id,
      payment_method_types: ['card'], // TODO make configurable per channel
      setup_future_usage: hasSubscriptionProducts
        ? 'off_session'
        : 'on_session',
      amount: order.totalWithTax,
      currency: order.currencyCode,
      metadata: {
        orderCode: order.code,
        channelToken: ctx.channel.token,
        amount: order.totalWithTax,
      },
    });
    Logger.info(
      `Created payment intent '${intent.id}' for order ${order.code}`,
      loggerCtx
    );
    return intent.client_secret!;
  }

  /**
   * Used for previewing the prices including VAT of a subscription
   */
  async getPricingForVariant(
    ctx: RequestContext,
    input: StripeSubscriptionPricingInput
  ): Promise<StripeSubscriptionPricing> {
    const variant = (await this.variantService.findOne(
      ctx,
      input.productVariantId!
    )) as VariantWithSubscriptionFields;
    if (!variant || !variant?.enabled) {
      throw new UserInputError(
        `No variant found with id ${input!.productVariantId}`
      );
    }
    if (!variant.listPrice) {
      throw new UserInputError(
        `Variant ${variant.id} doesn't have a "listPrice". Variant.listPrice is needed to calculate subscription pricing`
      );
    }
    if (!variant.customFields.subscriptionSchedule) {
      throw new UserInputError(
        `Variant ${variant.id} doesn't have a schedule attached`
      );
    }
    const subscriptionPricing = calculateSubscriptionPricing(
      ctx,
      variant.listPrice,
      variant.customFields.subscriptionSchedule,
      input
    );
    return {
      ...subscriptionPricing,
      variantId: variant.id as string,
      // original price is the same as the recurring price without discounts
      originalRecurringPrice: subscriptionPricing.recurringPrice,
    };
  }

  /**
   *
   * Calculate subscription pricing based on an orderLine.
   * This differs from a variant, because orderLines can have discounts applied
   */
  async getPricingForOrderLine(
    ctx: RequestContext,
    orderLine: OrderLineWithSubscriptionFields
  ): Promise<StripeSubscriptionPricing> {
    await this.entityHydrator.hydrate(ctx, orderLine, {
      relations: ['productVariant.taxCategory', 'order', 'order.promotions'],
      applyProductVariantPrices: true,
    });
    if (!orderLine.productVariant?.enabled) {
      throw new UserInputError(
        `Variant ${orderLine.productVariant.sku} is not enabled`
      );
    }
    if (!orderLine.productVariant.customFields.subscriptionSchedule) {
      throw new UserInputError(
        `Variant ${orderLine.productVariant.id} doesn't have a schedule attached`
      );
    }
    const subscriptionPricing = calculateSubscriptionPricing(
      ctx,
      orderLine.productVariant.listPrice,
      orderLine.productVariant.customFields.subscriptionSchedule,
      {
        downpayment: orderLine.customFields.downpayment,
        startDate: orderLine.customFields.startDate,
      }
    );
    // Execute promotions on recurringPrice
    const discountedRecurringPrice = await applySubscriptionPromotions(
      ctx,
      subscriptionPricing.recurringPrice,
      orderLine,
      orderLine.order.promotions || []
    );
    return {
      ...subscriptionPricing,
      variantId: orderLine.productVariant.id as string,
      originalRecurringPrice: subscriptionPricing.recurringPrice,
      recurringPrice: Math.round(discountedRecurringPrice),
    };
  }

  async savePaymentEvent(
    ctx: RequestContext,
    eventType: string,
    object: StripeInvoice
  ): Promise<void> {
    const stripeSubscriptionPaymentRepo = this.connection.getRepository(
      ctx,
      StripeSubscriptionPayment
    );
    const charge = object.lines.data.reduce(
      (acc, line) => acc + (line.plan?.amount ?? 0),
      0
    );
    const newPayment = new StripeSubscriptionPayment({
      channelId: ctx.channel.id as string,
      eventType,
      charge: charge,
      currency: object.currency ?? ctx.channel.defaultCurrencyCode,
      collectionMethod: object.collection_method,
      invoiceId: object.id,
      orderCode:
        object.metadata?.orderCode ??
        object.lines?.data[0]?.metadata.orderCode ??
        '',
      subscriptionId: object.subscription,
    });
    await stripeSubscriptionPaymentRepo.save(newPayment);
  }

  async getPaymentEvents(
    ctx: RequestContext,
    options: StripeSubscriptionPaymentListOptions
  ): Promise<StripeSubscriptionPaymentList> {
    return this.listQueryBuilder
      .build(StripeSubscriptionPayment, options, { ctx })
      .getManyAndCount()
      .then(([items, totalItems]) => ({
        items,
        totalItems,
      }));
  }

  /**
   * Handle future subscription payments that come in after the initial payment intent
   */
  async handleInvoicePaymentSucceeded(
    ctx: RequestContext,
    object: StripeInvoice,
    order: Order
  ): Promise<void> {
    const amount = object.lines?.data?.[0]?.plan?.amount;
    const message = amount
      ? `Received subscription payment of ${printMoney(amount)}`
      : 'Received subscription payment';
    await this.logHistoryEntry(
      ctx,
      order.id,
      message,
      undefined,
      undefined,
      object.subscription
    );
  }

  /**
   * Handle failed subscription payments that come in after the initial payment intent
   */
  async handleInvoicePaymentFailed(
    ctx: RequestContext,
    object: StripeInvoice,
    order: Order
  ): Promise<void> {
    const amount = object.lines?.data[0]?.plan?.amount;
    const message = amount
      ? `Subscription payment of ${printMoney(amount)} failed`
      : 'Subscription payment failed';
    await this.logHistoryEntry(
      ctx,
      order.id,
      message,
      `${message} - ${object.id}`,
      undefined,
      object.subscription
    );
  }

  /**
   * Handle the initial payment Intent succeeded.
   * Creates subscriptions in Stripe for customer attached to this order
   */
  async handlePaymentIntentSucceeded(
    ctx: RequestContext,
    object: StripePaymentIntent,
    order: Order
  ): Promise<void> {
    const {
      paymentMethod: { code: paymentMethodCode },
    } = await this.getStripeContext(ctx);
    if (!object.customer) {
      await this.logHistoryEntry(
        ctx,
        order.id,
        '',
        `No customer ID found in incoming webhook. Can not create subscriptions for this order.`
      );
      throw Error(`No customer found in webhook data for order ${order.code}`);
    }
    // Create subscriptions for customer
    this.jobQueue
      .add(
        {
          action: 'createSubscriptionsForOrder',
          ctx: ctx.serialize(),
          orderCode: order.code,
          stripePaymentMethodId: object.payment_method,
          stripeCustomerId: object.customer,
        },
        { retries: 0 } // Only 1 try, because subscription creation isn't transaction-proof
      )
      .catch((e) =>
        Logger.error(
          `Failed to add subscription-creation job to queue`,
          loggerCtx
        )
      );
    // Status is complete, we can settle payment
    if (order.state !== 'ArrangingPayment') {
      const transitionToStateResult = await this.orderService.transitionToState(
        ctx,
        order.id,
        'ArrangingPayment'
      );
      if (transitionToStateResult instanceof OrderStateTransitionError) {
        throw Error(
          `Error transitioning order ${order.code} from ${transitionToStateResult.fromState} to ${transitionToStateResult.toState}: ${transitionToStateResult.message}`
        );
      }
    }
    const addPaymentToOrderResult = await this.orderService.addPaymentToOrder(
      ctx,
      order.id,
      {
        method: paymentMethodCode,
        metadata: {
          setupIntentId: object.id,
          amount: object.metadata.amount,
        },
      }
    );
    if ((addPaymentToOrderResult as ErrorResult).errorCode) {
      throw Error(
        `Error adding payment to order ${order.code}: ${
          (addPaymentToOrderResult as ErrorResult).message
        }`
      );
    }
    Logger.info(
      `Successfully settled payment for order ${order.code} for channel ${ctx.channel.token}`,
      loggerCtx
    );
  }

  /**
   * Create subscriptions for customer based on order
   */
  private async createSubscriptions(
    ctx: RequestContext,
    orderCode: string,
    stripeCustomerId: string,
    stripePaymentMethodId: string
  ): Promise<void> {
    const order = (await this.orderService.findOneByCode(ctx, orderCode, [
      'customer',
      'lines',
      'lines.productVariant',
    ])) as OrderWithSubscriptionFields;
    if (!order) {
      throw Error(`Cannot find order with code ${orderCode}`);
    }
    if (!hasSubscriptions(order)) {
      return Logger.info(
        `Not creating subscriptions for order ${order.code}, because it doesn't have any subscription products`
      );
    }
    const { stripeClient } = await this.getStripeContext(ctx);
    const customer = await stripeClient.customers.retrieve(stripeCustomerId);
    if (!customer) {
      throw Error(
        `Failed to create subscription for ${stripeCustomerId} because the customer doesn't exist in Stripe`
      );
    }
    let orderLineCount = 0;
    const subscriptionOrderLines = order.lines.filter(
      (line) => line.productVariant.customFields.subscriptionSchedule
    );
    for (const orderLine of subscriptionOrderLines) {
      orderLineCount++; // Start with 1
      const createdSubscriptions: string[] = [];
      const pricing = await this.getPricingForOrderLine(ctx, orderLine);
      if (pricing.schedule.paidUpFront && !pricing.schedule.autoRenew) {
        continue; // Paid up front without autoRenew doesn't need a subscription
      }
      Logger.info(`Creating subscriptions for ${orderCode}`, loggerCtx);
      try {
        const product = await stripeClient.products.create({
          name: `${orderLine.productVariant.name} (${order.code})`,
        });
        const recurringSubscription =
          await stripeClient.createOffSessionSubscription({
            customerId: stripeCustomerId,
            productId: product.id,
            currencyCode: order.currencyCode,
            amount: pricing.recurringPrice,
            interval: pricing.interval,
            intervalCount: pricing.intervalCount,
            paymentMethodId: stripePaymentMethodId,
            startDate: pricing.subscriptionStartDate,
            endDate: pricing.subscriptionEndDate || undefined,
            description: orderLine.productVariant.name,
            orderCode: order.code,
            channelToken: ctx.channel.token,
          });
        createdSubscriptions.push(recurringSubscription.id);
        if (
          recurringSubscription.status !== 'active' &&
          recurringSubscription.status !== 'trialing'
        ) {
          Logger.error(
            `Failed to create active subscription ${recurringSubscription.id} for order ${order.code}! It is still in status '${recurringSubscription.status}'`,
            loggerCtx
          );
          await this.logHistoryEntry(
            ctx,
            order.id,
            'Failed to create subscription',
            `Subscription status is ${recurringSubscription.status}`,
            pricing,
            recurringSubscription.id
          );
        } else {
          Logger.info(
            `Created subscription ${recurringSubscription.id}: ${printMoney(
              pricing.recurringPrice
            )} every ${pricing.intervalCount} ${
              pricing.interval
            }(s) with startDate ${pricing.subscriptionStartDate} for order ${
              order.code
            }`,
            loggerCtx
          );
          await this.logHistoryEntry(
            ctx,
            order.id,
            `Created subscription for line ${orderLineCount}`,
            undefined,
            pricing,
            recurringSubscription.id
          );
        }
        if (pricing.downpayment) {
          // Create downpayment with the interval of the duration. So, if the subscription renews in 6 months, then the downpayment should occur every 6 months
          const downpaymentProduct = await stripeClient.products.create({
            name: `${orderLine.productVariant.name} - Downpayment (${order.code})`,
          });
          const schedule =
            orderLine.productVariant.customFields.subscriptionSchedule;
          if (!schedule) {
            throw new UserInputError(
              `Variant ${orderLine.productVariant.id} doesn't have a schedule attached`
            );
          }
          const downpaymentInterval = schedule.durationInterval;
          const downpaymentIntervalCount = schedule.durationCount;
          const nextDownpaymentDate = getNextCyclesStartDate(
            new Date(),
            schedule.startMoment,
            schedule.durationInterval,
            schedule.durationCount,
            schedule.fixedStartDate
          );
          const downpaymentSubscription =
            await stripeClient.createOffSessionSubscription({
              customerId: stripeCustomerId,
              productId: downpaymentProduct.id,
              currencyCode: order.currencyCode,
              amount: pricing.downpayment,
              interval: downpaymentInterval,
              intervalCount: downpaymentIntervalCount,
              paymentMethodId: stripePaymentMethodId,
              startDate: nextDownpaymentDate,
              endDate: pricing.subscriptionEndDate || undefined,
              description: `Downpayment`,
              orderCode: order.code,
              channelToken: ctx.channel.token,
            });
          createdSubscriptions.push(recurringSubscription.id);
          if (
            downpaymentSubscription.status !== 'active' &&
            downpaymentSubscription.status !== 'trialing'
          ) {
            Logger.error(
              `Failed to create active subscription ${downpaymentSubscription.id} for order ${order.code}! It is still in status '${downpaymentSubscription.status}'`,
              loggerCtx
            );
            await this.logHistoryEntry(
              ctx,
              order.id,
              'Failed to create downpayment subscription',
              'Failed to create active subscription',
              undefined,
              downpaymentSubscription.id
            );
          } else {
            Logger.info(
              `Created downpayment subscription ${
                downpaymentSubscription.id
              }: ${printMoney(
                pricing.downpayment
              )} every ${downpaymentIntervalCount} ${downpaymentInterval}(s) with startDate ${
                pricing.subscriptionStartDate
              } for order ${order.code}`,
              loggerCtx
            );
            await this.logHistoryEntry(
              ctx,
              order.id,
              `Created downpayment subscription for line ${orderLineCount}`,
              undefined,
              pricing,
              downpaymentSubscription.id
            );
          }
        }
        await this.saveSubscriptionIds(ctx, orderLine.id, createdSubscriptions);
      } catch (e: unknown) {
        await this.logHistoryEntry(ctx, order.id, '', e);
        throw e;
      }
    }
  }

  async saveSubscriptionIds(
    ctx: RequestContext,
    orderLineId: ID,
    subscriptionIds: string[]
  ) {
    await this.connection
      .getRepository(ctx, OrderLine)
      .update({ id: orderLineId }, { customFields: { subscriptionIds } });
  }

  async createContext(
    channelToken: string,
    req: Request
  ): Promise<RequestContext> {
    const channel = await this.channelService.getChannelFromToken(channelToken);
    return new RequestContext({
      apiType: 'admin',
      isAuthorized: true,
      authorizedAsOwnerOnly: false,
      channel,
      languageCode: LanguageCode.en,
      req,
    });
  }

  /**
   * Get the Stripe context for the current channel.
   * The Stripe context consists of the Stripe client and the Vendure payment method connected to the Stripe account
   */
  async getStripeContext(ctx: RequestContext): Promise<StripeContext> {
    const paymentMethods = await this.paymentMethodService.findAll(ctx, {
      filter: { enabled: { eq: true } },
    });
    const stripePaymentMethods = paymentMethods.items.filter(
      (pm) => pm.handler.code === stripeSubscriptionHandler.code
    );
    if (stripePaymentMethods.length > 1) {
      throw new UserInputError(
        `Multiple payment methods found with handler 'stripe-subscription', there should only be 1 per channel!`
      );
    }
    const paymentMethod = stripePaymentMethods[0];
    if (!paymentMethod) {
      throw new UserInputError(
        `No enabled payment method found with handler 'stripe-subscription'`
      );
    }
    const apiKey = paymentMethod.handler.args.find(
      (arg) => arg.name === 'apiKey'
    )?.value;
    let webhookSecret = paymentMethod.handler.args.find(
      (arg) => arg.name === 'webhookSecret'
    )?.value;
    if (!apiKey || !webhookSecret) {
      Logger.warn(
        `No api key or webhook secret is configured for ${paymentMethod.code}`,
        loggerCtx
      );
      throw Error(
        `Payment method ${paymentMethod.code} has no api key or webhook secret configured`
      );
    }
    return {
      paymentMethod: paymentMethod,
      stripeClient: new StripeClient(webhookSecret, apiKey, {
        apiVersion: null as any, // Null uses accounts default version
      }),
    };
  }

  async logHistoryEntry(
    ctx: RequestContext,
    orderId: ID,
    message: string,
    error?: unknown,
    pricing?: StripeSubscriptionPricing,
    subscriptionId?: string
  ): Promise<void> {
    let prettifiedError = error
      ? JSON.parse(JSON.stringify(error, Object.getOwnPropertyNames(error)))
      : undefined; // Make sure its serializable
    let prettifierPricing = pricing
      ? {
          ...pricing,
          totalProratedAmount: printMoney(pricing.totalProratedAmount),
          downpayment: printMoney(pricing.downpayment),
          recurringPrice: printMoney(pricing.recurringPrice),
          amountDueNow: printMoney(pricing.amountDueNow),
          dayRate: printMoney(pricing.dayRate),
        }
      : undefined;
    await this.historyService.createHistoryEntryForOrder(
      {
        ctx,
        orderId,
        type: 'STRIPE_SUBSCRIPTION_NOTIFICATION' as any,
        data: {
          message,
          valid: !error,
          error: prettifiedError,
          subscriptionId,
          pricing: prettifierPricing,
        },
      },
      false
    );
  }
}
