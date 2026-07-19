import { z } from 'zod';

import type { WebReadExecutionRequest, WebReadRequest } from './web-read-service';

const responseModeValues = ['content', 'markdown', 'html', 'text', 'frontmatter', 'readerlm-v2'] as const;
const engineValues = ['auto', 'browser', 'curl', 'cf-browser-rendering'] as const;
const respondTimingValues = ['html', 'visible-content', 'mutation-idle', 'resource-idle', 'media-idle', 'network-idle'] as const;
const retainLinksValues = ['none', 'all', 'text', 'gpt-oss'] as const;
const retainImagesValues = ['none', 'all', 'alt', 'all_p', 'alt_p'] as const;
const retainMediaValues = ['none', 'text', 'link', 'image', 'html'] as const;
const presetValues = ['reader', 'index', 'research', 'agent', 'spider'] as const;
const baseValues = ['initial', 'final'] as const;
const markdownChunkingValues = ['true', 'h1', 'h2', 'h3', 'h4', 'h5', 'structured', 's1', 's2', 's3', 's4', 's5'] as const;

const nonEmptyStringSchema = z.string().trim().min(1);
const selectorSchema = z.union([nonEmptyStringSchema, z.array(nonEmptyStringSchema).min(1)]);
const positiveIntegerSchema = z.number().int().min(1);

export const webReadRequestSchema = z.object({
  url: z.string(),
  responseMode: z.enum(responseModeValues).optional(),
  timeoutSeconds: z.number().int().min(1).max(180).optional(),
  noCache: z.boolean().optional(),
  cacheToleranceSeconds: z.number().int().min(0).optional(),
  waitForSelector: selectorSchema.optional(),
  targetSelector: selectorSchema.optional(),
  removeSelector: selectorSchema.optional(),
  keepImgDataUrl: z.boolean().optional(),
  robotsTxt: nonEmptyStringSchema.optional(),
  doNotTrack: z.boolean().optional(),
  withGeneratedAlt: z.boolean().optional(),
  withImagesSummary: z.boolean().optional(),
  withLinksSummary: z.union([z.boolean(), z.enum(['all', 'gpt-oss'])]).optional(),
  retainLinks: z.enum(retainLinksValues).optional(),
  retainImages: z.enum(retainImagesValues).optional(),
  retainMedia: z.enum(retainMediaValues).optional(),
  preset: z.enum(presetValues).optional(),
  withIframe: z.union([z.boolean(), z.literal('quoted')]).optional(),
  withShadowDom: z.boolean().optional(),
  engine: z.enum(engineValues).optional(),
  locale: nonEmptyStringSchema.optional(),
  referer: nonEmptyStringSchema.optional(),
  tokenBudget: positiveIntegerSchema.optional(),
  maxTokens: z.number().int().min(500).optional(),
  assertStatusCode: z.number().int().min(100).max(599).optional(),
  respondTiming: z.enum(respondTimingValues).optional(),
  base: z.enum(baseValues).optional(),
  removeOverlay: z.boolean().optional(),
  detachInvisibles: z.boolean().optional(),
  markdownChunking: z.enum(markdownChunkingValues).optional(),
  markdown: z.object({
    headingStyle: z.enum(['setext', 'atx']).optional(),
    hr: nonEmptyStringSchema.optional(),
    bulletListMarker: z.enum(['-', '+', '*']).optional(),
    emDelimiter: z.enum(['_', '*']).optional(),
    strongDelimiter: z.enum(['**', '__']).optional(),
    linkStyle: z.enum(['inlined', 'referenced', 'discarded']).optional(),
    linkReferenceStyle: z.enum(['full', 'collapsed', 'shortcut', 'discarded']).optional()
  }).optional()
}) satisfies z.ZodType<WebReadRequest>;

export const webReadExecutionRequestSchema = webReadRequestSchema.extend({
  signal: z.custom<AbortSignal>().optional()
}) satisfies z.ZodType<WebReadExecutionRequest>;

export const webReadToolSchema = webReadRequestSchema.extend({
  url: z.string().url(),
  responseMode: z.enum(responseModeValues).default('markdown'),
  timeoutSeconds: z.number().int().min(1).max(180).default(20),
  noCache: z.boolean().default(false)
}) satisfies z.ZodType<WebReadRequest>;
