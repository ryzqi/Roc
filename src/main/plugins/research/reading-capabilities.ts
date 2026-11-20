import {dialog} from 'electron';
import {writeFile} from 'node:fs/promises';
import type {z} from 'zod';
import type {CapabilityDescriptor,RocPluginContext} from '../../kernel/types';
import {RocDomainError} from '../../services/errors';
import type {ReadingRepository} from './reading-repository';
import type {ReadingDiscoveryService} from './reading-discovery';
import type {RadarService} from './radar-service';
import type {ReadingTranslationService} from './reading-translation';
import {readingDiscoveryRequestSchema,readingDiscoveryResultSchema,radarCapturePageSchema,radarArticleMarkSchema,radarArticleSchema,radarArticlesRequestSchema,radarArticlesSchema,radarFeedSaveSchema,radarFeedSchema,radarFeedsSchema,radarImportResultSchema,radarImportSchema,radarRecommendSchema,radarRecommendationsSchema,radarRefreshSchema,readingEmptySchema,readingExportResultSchema,readingHighlightListSchema,readingHighlightSaveSchema,readingHighlightSchema,readingHighlightsSchema,readingNoteExportSchema,readingNoteSaveSchema,readingNoteSchema,readingNotesSchema,readingScopeSchema,readingTranslateSchema,readingTranslationSchema,translationSettingsSaveSchema,translationSettingsSchema} from '../../../shared/schemas/research-reading';
const descriptor = <I,O>(name:string,inputSchema:z.ZodType<I>,outputSchema:z.ZodType<O>): CapabilityDescriptor<I,O> => ({name,version:'1.0.0',inputSchema,outputSchema});
const capabilities = {
  discoverReadingRelations:descriptor('research.reading.discoverReadingRelations',readingDiscoveryRequestSchema,readingDiscoveryResultSchema),
  captureRadarPage:descriptor('research.reading.captureRadarPage',radarCapturePageSchema,radarArticleSchema),
  listReadingNotes:descriptor('research.reading.listReadingNotes',readingScopeSchema,readingNotesSchema),
  saveReadingNote:descriptor('research.reading.saveReadingNote',readingNoteSaveSchema,readingNoteSchema),
  exportReadingNote:descriptor('research.reading.exportReadingNote',readingNoteExportSchema,readingExportResultSchema),
  listReadingHighlights:descriptor('research.reading.listReadingHighlights',readingHighlightListSchema,readingHighlightsSchema),
  saveReadingHighlight:descriptor('research.reading.saveReadingHighlight',readingHighlightSaveSchema,readingHighlightSchema),
  listRadarFeeds:descriptor('research.reading.listRadarFeeds',readingScopeSchema,radarFeedsSchema),
  saveRadarFeed:descriptor('research.reading.saveRadarFeed',radarFeedSaveSchema,radarFeedSchema),
  listRadarArticles:descriptor('research.reading.listRadarArticles',radarArticlesRequestSchema,radarArticlesSchema),
  refreshRadarFeed:descriptor('research.reading.refreshRadarFeed',radarRefreshSchema,radarFeedSchema),
  markRadarArticle:descriptor('research.reading.markRadarArticle',radarArticleMarkSchema,radarArticleSchema),
  importRadarArticle:descriptor('research.reading.importRadarArticle',radarImportSchema,radarImportResultSchema),
  recommendRadar:descriptor('research.reading.recommendRadar',radarRecommendSchema,radarRecommendationsSchema),
  getReadingTranslationSettings:descriptor('research.reading.getReadingTranslationSettings',readingEmptySchema,translationSettingsSchema),
  saveReadingTranslationSettings:descriptor('research.reading.saveReadingTranslationSettings',translationSettingsSaveSchema,translationSettingsSchema),
  translateReading:descriptor('research.reading.translateReading',readingTranslateSchema,readingTranslationSchema)
};
export const researchReadingCapabilities = Object.values(capabilities);
export function registerResearchReadingCapabilities(context:RocPluginContext,reading:ReadingRepository,radar:RadarService,translation:ReadingTranslationService,discovery:ReadingDiscoveryService):void {
  function register<I,O>(capability:CapabilityDescriptor<I,O>,run:(input:I)=>O|Promise<O>):void {
    context.capabilities.register(context.pluginId,capability,async raw=>{try {return await run(capability.inputSchema.parse(raw));}
      catch(error) {if (error instanceof RocDomainError) throw error; throw new RocDomainError({code:'research_reading_failed',message:error instanceof Error ? error.message : String(error),category:'validation',retryable:false});}});
  }
  register(capabilities.discoverReadingRelations,input=>discovery.discover(input));
  register(capabilities.captureRadarPage,input=>discovery.capturePage(input.projectId,input.url));
  register(capabilities.listReadingNotes,input => reading.notes(input.projectId));
  register(capabilities.saveReadingNote,input => reading.saveNote(input));
  register(capabilities.exportReadingNote,async input => {const note = reading.notes(input.projectId).find(note => note.id === input.noteId); if (!note || note.revision !== input.expectedRevision) throw new Error("笔记已更新，请重新保存后导出。"); const {canceled,filePath} = await dialog.showSaveDialog({defaultPath: `${note.title.replace(/[\\/:*?"<>|]/gu,"-")}.md`,filters:[{name:"Markdown",extensions:["md"]}]}); if (canceled || !filePath) return {path:null}; await writeFile(filePath,note.markdown,"utf8"); return {path:filePath};});
  register(capabilities.listReadingHighlights,input => reading.highlights(input.projectId,input.documentId,input.sourceHash));
  register(capabilities.saveReadingHighlight,input => reading.saveHighlight(input));
  register(capabilities.listRadarFeeds,input => radar.feeds(input.projectId));
  register(capabilities.saveRadarFeed,input => radar.saveFeed(input));
  register(capabilities.listRadarArticles,input => radar.articles(input.projectId,input.feedId,input.unread));
  register(capabilities.refreshRadarFeed,input => radar.refresh(input.projectId,input.feedId));
  register(capabilities.markRadarArticle,input => radar.mark(input.projectId,input.articleId,input.read));
  register(capabilities.importRadarArticle,input => radar.importArticle(input.projectId,input.articleId));
  register(capabilities.recommendRadar,input => radar.recommend(input.projectId,input.categories,input.force));
  register(capabilities.getReadingTranslationSettings,() => translation.settings());
  register(capabilities.saveReadingTranslationSettings,input => translation.save(input));
  register(capabilities.translateReading,input => {reading.scope(input.projectId); return translation.translate(input);});
}
