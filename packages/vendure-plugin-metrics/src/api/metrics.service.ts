import { Injectable } from '@nestjs/common';
import {
    AdvancedMetricSeries,
    AdvancedMetricSummary,
    AdvancedMetricSummaryEntry,
    AdvancedMetricSummaryInput,
} from '../ui/generated/graphql';
import {
    ConfigService,
    ID,
    Logger,
    Order,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';
import {
    Duration,
    endOfDay,
    getISOWeek,
    getMonth,
    startOfDay,
    sub,
} from 'date-fns';
import { loggerCtx } from '../constants';
import { Cache } from './cache';
import { AverageOrderValueMetric } from './metrics/average-order-value';
import { MetricStrategy } from './metric-strategy';
import { ca } from 'date-fns/locale';

export type MetricData = {
    orders: Order[];
};

@Injectable()
export class MetricsService {
    // Cache for datapoints
    cache = new Cache<AdvancedMetricSummary>();
    metricStrategies: MetricStrategy<unknown>[];
    constructor(
        private connection: TransactionalConnection,
        private configService: ConfigService
    ) {
        this.metricStrategies = [
            new AverageOrderValueMetric(),
        ];
    }

    async getMetrics(
        ctx: RequestContext,
        { variantIds }: AdvancedMetricSummaryInput
    ): Promise<AdvancedMetricSummary[]> {
        // TODO: 
        // Create from/to date. 
        // For each metric, loadData, split data in months, calculate entry for each month
        // Return with correct title and code
        // Set 23:59:59.999 as endDate
        const today = endOfDay(new Date());
        const oneYearAgo = startOfDay(sub(today, { years: 1 }));
        // For each metric strategy
        return Promise.all(this.metricStrategies.map(async (metric) => {
            const cacheKey = {
                from: today,
                to: oneYearAgo,
                channel: ctx.channel.token,
                variantIds: variantIds?.sort() ?? [],
            };
            const cachedMetricSummary = this.cache.get(cacheKey);
            if (cachedMetricSummary) {
                // Return cached result
                return cachedMetricSummary;

            }

            // See if available in cache
            // If not, load data
            // split data in months
            // Calculate entry for each month
            // Save in cache
            // Return
            return {
                code: metric.code,
                title: metric.getTitle(ctx),
                labels: [], // TODO get month names
                series: [],
                type: metric.metricType,
            }
        }));




        // Check if we have cached result
        const cacheKey = {
            startDate,
            channel: ctx.channel.token,
            variantIds: variantIds?.sort() ?? [],
        };
        const cachedMetricList = this.cache.get(cacheKey);
        if (cachedMetricList) {
            Logger.info(
                `Returning cached metrics for channel ${ctx.channel.token}`,
                loggerCtx
            );
            return cachedMetricList;
        }
        // No cache, calculating new metrics
        Logger.info(
            `No cache hit, calculating ${interval} metrics until ${endDate.toISOString()} for channel ${ctx.channel.token
            } for ${variantIds?.length
                ? `for order containing product variants with ids ${variantIds}`
                : 'all orders'
            }`,
            loggerCtx
        );
        const data = await this.loadData(
            ctx,
            interval,
            endDate,
            variantIds as string[]
        );
        const metrics: AdvancedMetricSummary[] = [];
        this.metricStrategies.forEach((metric) => {
            // Calculate entry (month or week)
            const entries: AdvancedMetricSummaryEntry[] = [];
            data.forEach((dataPerTick, weekOrMonthNr) => {
                entries.push(
                    metric.calculateEntry(ctx, interval, weekOrMonthNr, dataPerTick)
                );
            });
            // Create metric with calculated entries
            metrics.push({
                interval,
                title: metric.getTitle(ctx),
                code: metric.code,
                entries,
                type: metric.metricType,
            });
        });
        this.cache.set(cacheKey, metrics);
        return metrics;
    }

    mapToSeries(dataPoints: number[][], labels: string[]): AdvancedMetricSeries[] {
        return dataPoints.map((dataPoint, index) => ({
            values: dataPoint,
            name: labels[index],
        }));
    }

    async loadData(
        ctx: RequestContext,
        interval: AdvancedMetricInterval,
        endDate: Date,
        variantIds?: ID[]
    ): Promise<Map<number, MetricData>> {
        let nrOfEntries: number;
        let backInTimeAmount: Duration;
        const orderRepo = this.connection.getRepository(ctx, Order);
        // What function to use to get the current Tick of a date (i.e. the week or month number)
        let getTickNrFn: typeof getMonth | typeof getISOWeek;
        let maxTick: number;
        if (interval === AdvancedMetricInterval.Monthly) {
            nrOfEntries = 12;
            backInTimeAmount = { months: nrOfEntries };
            getTickNrFn = getMonth;
            maxTick = 12; // max 12 months
        } else {
            // Weekly
            nrOfEntries = 26;
            backInTimeAmount = { weeks: nrOfEntries };
            getTickNrFn = getISOWeek;
            maxTick = 52; // max 52 weeks
        }
        const startDate = startOfDay(sub(endDate, backInTimeAmount));
        const startTick = getTickNrFn(startDate);
        // Get orders in a loop until we have all
        let skip = 0;
        const take = 1000;
        let hasMoreOrders = true;
        const orders: Order[] = [];
        while (hasMoreOrders) {
            let query = orderRepo
                .createQueryBuilder('order')
                .leftJoinAndSelect('order.lines', 'orderLine')
                .leftJoin('orderLine.productVariant', 'productVariant')
                .leftJoin('order.channels', 'orderChannel')
                .where(`orderChannel.id=:channelId`, { channelId: ctx.channelId })
                .andWhere(`order.orderPlacedAt >= :startDate`, {
                    startDate: startDate.toISOString(),
                })
                .skip(skip)
                .take(take);
            if (variantIds?.length) {
                query = query.andWhere(`productVariant.id IN(:...variantIds)`, {
                    variantIds,
                });
            }
            const [items, nrOfOrders] = await query.getManyAndCount();
            orders.push(...items);
            Logger.info(
                `Fetched orders ${skip}-${skip + take} for channel ${ctx.channel.token
                } for ${interval} metrics`,
                loggerCtx
            );
            skip += items.length;
            if (orders.length >= nrOfOrders) {
                hasMoreOrders = false;
            }
        }
        Logger.info(
            `Finished fetching all ${orders.length} orders for channel ${ctx.channel.token} for ${interval} metrics`,
            loggerCtx
        );
        const dataPerInterval = new Map<number, MetricData>();
        const ticks = [];
        for (let i = 1; i <= nrOfEntries; i++) {
            if (startTick + i >= maxTick) {
                // make sure we dont go over month 12 or week 52
                ticks.push(startTick + i - maxTick);
            } else {
                ticks.push(startTick + i);
            }
        }
        ticks.forEach((tick) => {
            const ordersInCurrentTick = orders.filter(
                (order) => getTickNrFn(order.orderPlacedAt!) === tick
            );
            dataPerInterval.set(tick, {
                orders: ordersInCurrentTick,
            });
        });
        return dataPerInterval;
    }
}
