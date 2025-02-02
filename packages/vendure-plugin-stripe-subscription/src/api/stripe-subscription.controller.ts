import { Body, Controller, Headers, Inject, Post, Req } from '@nestjs/common';
import {
  Args,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import {
  Allow,
  Api,
  Ctx,
  EntityHydrator,
  ID,
  Logger,
  OrderService,
  PaymentMethodService,
  Permission,
  ProductService,
  ProductVariantService,
  RequestContext,
  UserInputError,
} from '@vendure/core';
import { PaymentMethodQuote } from '@vendure/common/lib/generated-shop-types';
import { Request } from 'express';
import { loggerCtx, PLUGIN_INIT_OPTIONS } from '../constants';
import { StripeSubscriptionPluginOptions } from '../stripe-subscription.plugin';
import {
  StripeSubscriptionPaymentList,
  StripeSubscriptionPaymentListOptions,
  StripeSubscriptionPricing,
  StripeSubscriptionPricingInput,
  StripeSubscriptionSchedule,
  StripeSubscriptionScheduleList,
  StripeSubscriptionScheduleListOptions,
  UpsertStripeSubscriptionScheduleInput,
} from '../ui/generated/graphql';
import { ScheduleService } from './schedule.service';
import { StripeSubscriptionService } from './stripe-subscription.service';
import {
  OrderLineWithSubscriptionFields,
  VariantWithSubscriptionFields,
} from './subscription-custom-fields';
import { StripeInvoice } from './types/stripe-invoice';
import { StripePaymentIntent } from './types/stripe-payment-intent';
import { IncomingStripeWebhook } from './types/stripe.types';
import { ApiType } from '@vendure/core/dist/api/common/get-api-type';

export type RequestWithRawBody = Request & { rawBody: any };

@Resolver()
export class ShopResolver {
  constructor(
    private stripeSubscriptionService: StripeSubscriptionService,
    private orderService: OrderService,
    private productService: ProductService,
    private paymentMethodService: PaymentMethodService
  ) {}

  @Mutation()
  @Allow(Permission.Owner)
  async createStripeSubscriptionIntent(
    @Ctx() ctx: RequestContext
  ): Promise<string> {
    return this.stripeSubscriptionService.createPaymentIntent(ctx);
  }

  @Query()
  async stripeSubscriptionPricing(
    @Ctx() ctx: RequestContext,
    @Args('input') input: StripeSubscriptionPricingInput
  ): Promise<StripeSubscriptionPricing> {
    return this.stripeSubscriptionService.getPricingForVariant(ctx, input);
  }

  @Query()
  async stripeSubscriptionPricingForProduct(
    @Ctx() ctx: RequestContext,
    @Args('productId') productId: ID
  ): Promise<StripeSubscriptionPricing[]> {
    const product = await this.productService.findOne(ctx, productId, [
      'variants',
    ]);
    if (!product) {
      throw new UserInputError(`No product with id '${productId}' found`);
    }
    const subscriptionVariants = product.variants.filter(
      (v: VariantWithSubscriptionFields) =>
        !!v.customFields.subscriptionSchedule && v.enabled
    );
    return await Promise.all(
      subscriptionVariants.map((variant) =>
        this.stripeSubscriptionService.getPricingForVariant(ctx, {
          productVariantId: variant.id as string,
        })
      )
    );
  }

  @ResolveField('stripeSubscriptionPublishableKey')
  @Resolver('PaymentMethodQuote')
  async stripeSubscriptionPublishableKey(
    @Ctx() ctx: RequestContext,
    @Parent() paymentMethodQuote: PaymentMethodQuote
  ): Promise<string | undefined> {
    const paymentMethod = await this.paymentMethodService.findOne(
      ctx,
      paymentMethodQuote.id
    );
    if (!paymentMethod) {
      throw new UserInputError(
        `No payment method with id '${paymentMethodQuote.id}' found. Unable to resolve field"stripeSubscriptionPublishableKey"`
      );
    }
    return paymentMethod.handler.args.find((a) => a.name === 'publishableKey')
      ?.value;
  }
}

@Resolver('OrderLine')
export class OrderLinePricingResolver {
  constructor(
    private entityHydrator: EntityHydrator,
    private subscriptionService: StripeSubscriptionService
  ) {}

  @ResolveField()
  async subscriptionPricing(
    @Ctx() ctx: RequestContext,
    @Parent() orderLine: OrderLineWithSubscriptionFields
  ): Promise<StripeSubscriptionPricing | undefined> {
    await this.entityHydrator.hydrate(ctx, orderLine, {
      relations: ['productVariant'],
    });
    if (orderLine.productVariant?.customFields?.subscriptionSchedule) {
      return await this.subscriptionService.getPricingForOrderLine(
        ctx,
        orderLine
      );
    }
    return;
  }
}

// This is needed to resolve schedule.pricesIncludeTax in the Admin UI
@Resolver('StripeSubscriptionSchedule')
export class AdminPriceIncludesTaxResolver {
  @ResolveField()
  pricesIncludeTax(
    @Ctx() ctx: RequestContext,
    @Parent() orderLine: OrderLineWithSubscriptionFields
  ): boolean {
    return ctx.channel.pricesIncludeTax;
  }
}

@Resolver()
export class AdminResolver {
  constructor(
    private stripeSubscriptionService: StripeSubscriptionService,
    private scheduleService: ScheduleService
  ) {}

  @Allow(Permission.ReadSettings)
  @Query()
  async stripeSubscriptionSchedules(
    @Ctx() ctx: RequestContext,
    @Args('options') options: StripeSubscriptionScheduleListOptions
  ): Promise<StripeSubscriptionScheduleList> {
    return this.scheduleService.getSchedules(ctx, options);
  }

  @Allow(Permission.ReadSettings)
  @Query()
  async stripeSubscriptionPayments(
    @Ctx() ctx: RequestContext,
    @Args('options') options: StripeSubscriptionPaymentListOptions
  ): Promise<StripeSubscriptionPaymentList> {
    return this.stripeSubscriptionService.getPaymentEvents(ctx, options);
  }

  @Allow(Permission.UpdateSettings)
  @Mutation()
  async upsertStripeSubscriptionSchedule(
    @Ctx() ctx: RequestContext,
    @Args('input') input: UpsertStripeSubscriptionScheduleInput
  ): Promise<StripeSubscriptionSchedule> {
    return this.scheduleService.upsert(ctx, input);
  }

  @Allow(Permission.UpdateSettings)
  @Mutation()
  async deleteStripeSubscriptionSchedule(
    @Ctx() ctx: RequestContext,
    @Args('scheduleId') scheduleId: string
  ): Promise<void> {
    return this.scheduleService.delete(ctx, scheduleId);
  }
}

@Controller('stripe-subscriptions')
export class StripeSubscriptionController {
  constructor(
    private stripeSubscriptionService: StripeSubscriptionService,
    private orderService: OrderService,
    @Inject(PLUGIN_INIT_OPTIONS)
    private options: StripeSubscriptionPluginOptions
  ) {}

  @Post('webhook')
  async webhook(
    @Headers('stripe-signature') signature: string | undefined,
    @Req() request: RequestWithRawBody,
    @Body() body: IncomingStripeWebhook
  ): Promise<void> {
    Logger.info(`Incoming webhook ${body.type}`, loggerCtx);
    // Validate if metadata present
    const orderCode =
      body.data.object.metadata?.orderCode ??
      (body.data.object as StripeInvoice).lines?.data[0]?.metadata.orderCode;
    const channelToken =
      body.data.object.metadata?.channelToken ??
      (body.data.object as StripeInvoice).lines?.data[0]?.metadata.channelToken;
    if (
      body.type !== 'payment_intent.succeeded' &&
      body.type !== 'invoice.payment_failed' &&
      body.type !== 'invoice.payment_succeeded'
    ) {
      Logger.info(
        `Received incoming '${body.type}' webhook, not processing this event.`,
        loggerCtx
      );
      return;
    }
    if (!orderCode) {
      return Logger.error(
        `Incoming webhook is missing metadata.orderCode, cannot process this event`,
        loggerCtx
      );
    }
    if (!channelToken) {
      return Logger.error(
        `Incoming webhook is missing metadata.channelToken, cannot process this event`,
        loggerCtx
      );
    }
    try {
      const ctx = await this.stripeSubscriptionService.createContext(
        channelToken,
        request
      );
      const order = await this.orderService.findOneByCode(ctx, orderCode);
      if (!order) {
        throw Error(`Cannot find order with code ${orderCode}`); // Throw inside catch block, so Stripe will retry
      }
      // Validate signature
      const { stripeClient } =
        await this.stripeSubscriptionService.getStripeContext(ctx);
      if (!this.options?.disableWebhookSignatureChecking) {
        stripeClient.validateWebhookSignature(request.rawBody, signature);
      }
      if (body.type === 'payment_intent.succeeded') {
        await this.stripeSubscriptionService.handlePaymentIntentSucceeded(
          ctx,
          body.data.object as StripePaymentIntent,
          order
        );
      } else if (body.type === 'invoice.payment_succeeded') {
        const invoiceObject = body.data.object as StripeInvoice;
        await this.stripeSubscriptionService.handleInvoicePaymentSucceeded(
          ctx,
          invoiceObject,
          order
        );
        await this.stripeSubscriptionService.savePaymentEvent(
          ctx,
          body.type,
          invoiceObject
        );
      } else if (body.type === 'invoice.payment_failed') {
        const invoiceObject = body.data.object as StripeInvoice;
        await this.stripeSubscriptionService.handleInvoicePaymentFailed(
          ctx,
          invoiceObject,
          order
        );
        await this.stripeSubscriptionService.savePaymentEvent(
          ctx,
          body.type,
          invoiceObject
        );
      } else if (body.type === 'invoice.payment_action_required') {
        const invoiceObject = body.data.object as StripeInvoice;
        await this.stripeSubscriptionService.handleInvoicePaymentFailed(
          ctx,
          invoiceObject,
          order
        );
        await this.stripeSubscriptionService.savePaymentEvent(
          ctx,
          body.type,
          invoiceObject
        );
      }
      Logger.info(`Successfully handled webhook ${body.type}`, loggerCtx);
    } catch (error) {
      // Catch all for logging purposes
      Logger.error(
        `Failed to process incoming webhook ${body.type} (${body.id}): ${
          (error as Error)?.message
        }`,
        loggerCtx,
        (error as Error)?.stack
      );
      throw error;
    }
  }
}
