/*
Copyright (c) Walmart Inc.

This source code is licensed under the Apache 2.0 license found in the
LICENSE file in the root directory of this source tree.
*/

import {
    DefaultComponentContext,
    IComponentContext,
    IDisposable,
    ILogger,
    IOutputSink,
    IOutputSinkGuarantees,
    IPublishedMessage,
    IRequireInitialization,
    OutputSinkConsistencyLevel,
    IMetrics,
    OpenTracingTagKeys,
    failSpan,
} from "@walmartlabs/cookie-cutter-core";
import { Span, SpanContext, Tags, Tracer } from "opentracing";
import { PubSub, Attributes } from "@google-cloud/pubsub";
import { IGcpAuthConfiguration, IPubSubPublisherConfiguration } from ".";
import {
    AttributeNames,
    PubSubMetricResults,
    PubSubMetrics,
    PubSubOpenTracingTagKeys,
} from "./model";

interface IPayloadWithAttributes {
    payload: Buffer;
    attributes: Attributes;
    spanContext: SpanContext;
    orderingKey?: string;
}

interface IPubSubTopicPayload {
    messages: IPayloadWithAttributes[];
    messageOrdering: boolean;
}

export enum PubSubMetadata {
    Topic = "topic",
    Key = "orderingKey",
}

/*
 * Output sink to produce to Google's PubSub topics.
 */
export class PubSubSink
    implements IOutputSink<IPublishedMessage>, IRequireInitialization, IDisposable
{
    private readonly producer: PubSub;
    private logger: ILogger;
    private tracer: Tracer;
    private metrics: IMetrics;
    private spanOperationName: string = "Write to Google PubSub";

    constructor(private readonly config: IGcpAuthConfiguration & IPubSubPublisherConfiguration) {
        this.logger = DefaultComponentContext.logger;
        this.tracer = DefaultComponentContext.tracer;
        this.producer = new PubSub({
            projectId: this.config.projectId,
            credentials: {
                client_email: this.config.clientEmail,
                private_key: this.config.privateKey,
            },
        });
    }

    public async initialize(ctx: IComponentContext): Promise<void> {
        this.logger = ctx.logger;
        this.tracer = ctx.tracer;
        this.metrics = ctx.metrics;
    }

    public async sink(output: IterableIterator<IPublishedMessage>): Promise<void> {
        const pubSubPayloadByTopic: Map<string, IPubSubTopicPayload> = new Map();
        for (const msg of output) {
            const topicName = msg.metadata[PubSubMetadata.Topic] || this.config.defaultTopic;
            if (!pubSubPayloadByTopic.has(topicName)) {
                pubSubPayloadByTopic.set(topicName, {
                    messageOrdering: false,
                    messages: [],
                });
            }

            const formattedMsg = this.formatMessage(msg);
            const topic = pubSubPayloadByTopic.get(topicName);

            topic.messages.push(formattedMsg);
            if (!topic.messageOrdering && formattedMsg.orderingKey) {
                topic.messageOrdering = true;
            }
        }
        for (const [topic, topicPayload] of pubSubPayloadByTopic) {
            const batchPublisher = this.producer.topic(topic, {
                batching: {
                    maxBytes: this.config.maxPayloadSize,
                    maxMessages: this.config.maximumBatchSize,
                    maxMilliseconds: this.config.maximumBatchWaitTime,
                },
                messageOrdering: topicPayload.messageOrdering,
            });
            for (const message of topicPayload.messages) {
                const span = this.tracer.startSpan(this.spanOperationName, {
                    childOf: message.spanContext,
                });
                this.spanLogAndSetTags(span, this.sink.name, topic);
                try {
                    const messageId = await batchPublisher.publishMessage({
                        data: message.payload,
                        attributes: message.attributes,
                        orderingKey: message.orderingKey,
                    });

                    span.log({ messageId });
                    this.emitMetrics(
                        topic,
                        message.attributes[AttributeNames.eventType],
                        PubSubMetricResults.Success
                    );
                    this.logger.debug("Message published to PubSub", { topic, messageId });
                } catch (e) {
                    failSpan(span, e);
                    topicPayload.messages.forEach((message) =>
                        this.emitMetrics(
                            topic,
                            message.attributes[AttributeNames.eventType],
                            PubSubMetricResults.Error
                        )
                    );
                    throw e;
                } finally {
                    span.finish();
                }
            }
        }
    }

    public async dispose(): Promise<void> {
        if (this.producer) {
            await this.producer.close();
        }
    }

    public get guarantees(): IOutputSinkGuarantees {
        return {
            consistency: OutputSinkConsistencyLevel.None,
            idempotent: false,
            maxBatchSize: this.config.maximumBatchSize,
        };
    }

    private spanLogAndSetTags(span: Span, funcName: string, topic: string): void {
        span.log({ topic });
        span.setTag(Tags.SPAN_KIND, Tags.SPAN_KIND_RPC_CLIENT);
        span.setTag(Tags.COMPONENT, "cookie-cutter-pubSub");
        span.setTag(OpenTracingTagKeys.FunctionName, funcName);
        span.setTag(PubSubOpenTracingTagKeys.TopicName, topic);
    }

    private emitMetrics(topic: string, eventType: string, result: PubSubMetricResults) {
        this.metrics.increment(PubSubMetrics.MsgPublished, {
            topic,
            event_type: eventType,
            result,
        });
    }

    private formatMessage(msg: IPublishedMessage): IPayloadWithAttributes {
        const timestamp = Date.now().toString();
        const payload: Buffer = Buffer.from(this.config.encoder.encode(msg.message));

        const attributes: Attributes = {
            [AttributeNames.timestamp]: timestamp,
            [AttributeNames.eventType]: msg.message.type,
            [AttributeNames.contentType]: this.config.encoder.mimeType,
        };

        return {
            payload,
            attributes,
            spanContext: msg.spanContext,
            orderingKey: msg.metadata[PubSubMetadata.Key]
                ? msg.metadata[PubSubMetadata.Key]
                : undefined,
        };
    }
}
