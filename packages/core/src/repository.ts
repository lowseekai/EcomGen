import type { SqliteDatabase } from "./database.js";
import { AssetRepository, type AssetRecord } from "./repositories/assetRepository.js";
import {
  EditSessionRepository,
  type EditReferenceAssetRecord,
  type EditSessionRecord,
  type EditTurnRecord,
} from "./repositories/editSessionRepository.js";
import {
  ExportRepository,
  type ExportRecord,
  type LayerExportRecord,
  type LayerPlanRecord,
} from "./repositories/exportRepository.js";
import {
  JobRepository,
  type CopywritingResultRecord,
  type JobRecord,
  type WebResearchAuditRecord,
  type WebResearchAttemptRecord,
} from "./repositories/jobRepository.js";
import { LibraryRepository, type LibraryItemPage } from "./repositories/libraryRepository.js";
import {
  ModelRepository,
  type ModelPortraitRecord,
  type ModelRecord,
} from "./repositories/modelRepository.js";
import { OutputRepository, type OutputRecord } from "./repositories/outputRepository.js";
import {
  PatternPipelineRepository,
  type PatternPipelineStepRecord,
  type PatternPipelineWithSteps,
} from "./repositories/patternPipelineRepository.js";
import {
  PatternDraftRepository,
  type DraftBatchRecord,
  type DraftCandidateRecord,
  type DraftMediaRecord,
  type DraftSlotRecord,
  type PatternDraftRecord,
  type UpdateDraftResult,
} from "./repositories/patternDraftRepository.js";
import {
  PatternRepository,
  type PatternListingResultRecord,
  type PatternRecord,
  type PrintPackRecord,
} from "./repositories/patternRepository.js";
import {
  ProjectRepository,
  type PlanningConfigSnapshotRecord,
  type ProjectCoverSummary,
  type ProjectRecord,
} from "./repositories/projectRepository.js";
import { ProviderRepository, type ProviderRecord } from "./repositories/providerRepository.js";
import { SearchSourceRepository, type SearchSourceRecord } from "./repositories/searchSourceRepository.js";
import {
  StoryboardRepository,
  type StoryboardItemRecord,
  type StoryboardRecord,
} from "./repositories/storyboardRepository.js";
import {
  UserContentRepository,
  type SuiteForgeResultRecord,
  type UserSuiteRecord,
  type UserTemplateRecord,
} from "./repositories/userContentRepository.js";
import {
  UserRepository,
  normalizeEmail,
  type AuditEventInput,
  type LoginEventInput,
  type SessionRecord,
  type UserListQuery,
  type UserRecord,
  type UserRole,
  type UserStatus,
} from "./repositories/userRepository.js";
import {
  CreditRepository,
  MICROCREDITS_PER_CREDIT,
  type CreditEntryInput,
  type CreditEntryRecord,
  type CreditLedgerType,
} from "./repositories/creditRepository.js";
import {
  PlanRepository,
  FALLBACK_ENTITLEMENTS,
  UNLIMITED_ENTITLEMENTS,
  mergeEntitlements,
  type Entitlements,
  type ImageResolutionCap,
  type PlanRecord,
  type SubscriptionRecord,
  type SubscriptionStatus,
} from "./repositories/planRepository.js";
import {
  BillingRepository,
  type BillingOrderRecord,
  type BillingStatus,
  type PricingMode,
  type ProviderModelPriceRecord,
} from "./repositories/billingRepository.js";
import {
  PaymentRepository,
  type PaymentNotificationStatus,
  type PaymentOrderRecord,
  type PaymentOrderStatus,
} from "./repositories/paymentRepository.js";
import { AdminRepository, type AdminOverview } from "./repositories/adminRepository.js";
import { StorageRepository, type SizedTable } from "./repositories/storageRepository.js";
import { SYSTEM_SCOPE, ownerScope, resolveScope, type RepositoryScope, type ScopeInput } from "./scope.js";

export * from "./repositories/adminRepository.js";
export * from "./repositories/assetRepository.js";
export * from "./repositories/billingRepository.js";
export * from "./repositories/creditRepository.js";
export * from "./repositories/editSessionRepository.js";
export * from "./repositories/exportRepository.js";
export * from "./repositories/jobRepository.js";
export * from "./repositories/libraryRepository.js";
export * from "./repositories/modelRepository.js";
export * from "./repositories/outputRepository.js";
export * from "./repositories/patternDraftRepository.js";
export * from "./repositories/patternPipelineRepository.js";
export * from "./repositories/patternRepository.js";
export * from "./repositories/paymentRepository.js";
export * from "./repositories/planRepository.js";
export * from "./repositories/projectRepository.js";
export * from "./repositories/providerRepository.js";
export * from "./repositories/searchSourceRepository.js";
export * from "./repositories/storageRepository.js";
export * from "./repositories/storyboardRepository.js";
export * from "./repositories/userContentRepository.js";
export * from "./repositories/userRepository.js";

/**
 * 领域持久化的唯一门面：按聚合根组合各子仓库（providers、models、patterns、jobs、projects……）。
 *
 * 保留单一门面而不是让调用方直接持有子仓库，有两个原因：
 * - SQLite 事务边界以「db 连接」为单位，门面是唯一能保证跨聚合写（如删除 Provider 级联清引用）
 *   在同一连接上发生的地方；
 * - pattern-pipeline.ts、suite-catalog.ts 与 api/worker 依赖这里的聚合读取口组合出领域流程，
 *   门面让它们不必感知仓库拆分。
 */
export class EcomRepository {
  private readonly providers: ProviderRepository;
  private readonly searchSources: SearchSourceRepository;
  private readonly userContent: UserContentRepository;
  private readonly models: ModelRepository;
  private readonly patterns: PatternRepository;
  private readonly drafts: PatternDraftRepository;
  private readonly pipelines: PatternPipelineRepository;
  private readonly projects: ProjectRepository;
  private readonly assets: AssetRepository;
  private readonly storyboards: StoryboardRepository;
  private readonly jobs: JobRepository;
  private readonly outputs: OutputRepository;
  private readonly editSessions: EditSessionRepository;
  private readonly exports: ExportRepository;
  private readonly library: LibraryRepository;
  private readonly users: UserRepository;
  private readonly credits: CreditRepository;
  private readonly plans: PlanRepository;
  private readonly billing: BillingRepository;
  private readonly payments: PaymentRepository;
  private readonly storage: StorageRepository;
  private readonly admin: AdminRepository;

  public constructor(private readonly db: SqliteDatabase, private readonly scope: ScopeInput = SYSTEM_SCOPE) {
    this.providers = new ProviderRepository(db);
    this.searchSources = new SearchSourceRepository(db);
    this.userContent = new UserContentRepository(db, scope);
    this.models = new ModelRepository(db, scope);
    this.patterns = new PatternRepository(db, scope);
    this.drafts = new PatternDraftRepository(db, scope);
    this.pipelines = new PatternPipelineRepository(db, scope);
    this.projects = new ProjectRepository(db, scope);
    this.assets = new AssetRepository(db, scope);
    this.storyboards = new StoryboardRepository(db, scope, this.projects);
    this.jobs = new JobRepository(db, scope);
    this.outputs = new OutputRepository(db, scope);
    this.editSessions = new EditSessionRepository(db, scope);
    this.exports = new ExportRepository(db, scope);
    this.library = new LibraryRepository(db, scope, {
      getAsset: (id) => this.assets.getAsset(id),
      getOutput: (id) => this.outputs.getOutput(id),
      getLayerExport: (id) => this.exports.getLayerExport(id),
      getPattern: (id) => this.patterns.getPattern(id),
      getPrintPack: (id) => this.patterns.getPrintPack(id),
      getModelPortrait: (id) => this.models.getModelPortrait(id),
      getModel: (id) => this.models.getModel(id),
    });
    this.users = new UserRepository(db);
    this.credits = new CreditRepository(db);
    this.plans = new PlanRepository(db);
    this.billing = new BillingRepository(db);
    this.payments = new PaymentRepository(db);
    this.storage = new StorageRepository(db);
    this.admin = new AdminRepository(db);
  }

  /**
   * 派生一个绑定到指定所有者的仓储实例。
   *
   * 共享同一个 db 连接，因此事务边界与改造前一致；只是每条查询多带一个归属谓词。
   * 请求期通常不需要它——`buildApi` 交给路由的实例已经从请求上下文取作用域（见 scope.ts）。
   */
  public forOwner(ownerId: string): EcomRepository {
    return new EcomRepository(this.db, ownerScope(ownerId));
  }

  /** 当前作用域，仅供诊断与测试断言使用。 */
  public get currentScope(): RepositoryScope { return resolveScope(this.scope); }

  // ---- providers ----
  public listProviders(): ProviderRecord[] { return this.providers.listProviders(); }
  public getProvider(id: string): ProviderRecord | undefined { return this.providers.getProvider(id); }
  public saveProvider(input: Parameters<ProviderRepository["saveProvider"]>[0]): ProviderRecord { return this.providers.saveProvider(input); }
  public deleteProvider(id: string): "deleted" | "missing" { return this.providers.deleteProvider(id); }

  // ---- search sources ----
  public listSearchSources(): SearchSourceRecord[] { return this.searchSources.listSearchSources(); }
  public getSearchSource(id: string): SearchSourceRecord | undefined { return this.searchSources.getSearchSource(id); }
  public saveSearchSource(input: Parameters<SearchSourceRepository["saveSearchSource"]>[0]): SearchSourceRecord { return this.searchSources.saveSearchSource(input); }
  public deleteSearchSource(id: string): boolean { return this.searchSources.deleteSearchSource(id); }

  // ---- user templates / suites / suite forge drafts ----
  public listUserTemplates(): UserTemplateRecord[] { return this.userContent.listUserTemplates(); }
  public getUserTemplate(id: string): UserTemplateRecord | undefined { return this.userContent.getUserTemplate(id); }
  public saveUserTemplate(input: Parameters<UserContentRepository["saveUserTemplate"]>[0]): UserTemplateRecord { return this.userContent.saveUserTemplate(input); }
  public deleteUserTemplate(id: string): boolean { return this.userContent.deleteUserTemplate(id); }
  public listUserSuites(): UserSuiteRecord[] { return this.userContent.listUserSuites(); }
  public getUserSuite(id: string): UserSuiteRecord | undefined { return this.userContent.getUserSuite(id); }
  public saveUserSuite(input: Parameters<UserContentRepository["saveUserSuite"]>[0]): UserSuiteRecord { return this.userContent.saveUserSuite(input); }
  public deleteUserSuite(id: string): boolean { return this.userContent.deleteUserSuite(id); }
  public saveSuiteForgeResult(input: Parameters<UserContentRepository["saveSuiteForgeResult"]>[0]): SuiteForgeResultRecord { return this.userContent.saveSuiteForgeResult(input); }
  public getSuiteForgeResult(jobId: string): SuiteForgeResultRecord | undefined { return this.userContent.getSuiteForgeResult(jobId); }
  public commitSuiteForgeResult(jobId: string, suiteId: string): SuiteForgeResultRecord | undefined { return this.userContent.commitSuiteForgeResult(jobId, suiteId); }

  // ---- models & portraits ----
  public listModels(): ModelRecord[] { return this.models.listModels(); }
  public getModel(id: string): ModelRecord | undefined { return this.models.getModel(id); }
  public createModel(input: Parameters<ModelRepository["createModel"]>[0]): ModelRecord { return this.models.createModel(input); }
  public updateModel(id: string, patch: Parameters<ModelRepository["updateModel"]>[1]): ModelRecord | undefined { return this.models.updateModel(id, patch); }
  public setModelReferenceFace(id: string, path: string | null, hash: string | null): ModelRecord | undefined { return this.models.setModelReferenceFace(id, path, hash); }
  public deleteModel(id: string): boolean { return this.models.deleteModel(id); }
  public listModelPortraits(modelId: string): ModelPortraitRecord[] { return this.models.listModelPortraits(modelId); }
  public getModelPortrait(portraitId: string): ModelPortraitRecord | undefined { return this.models.getModelPortrait(portraitId); }
  public createModelPortrait(input: Parameters<ModelRepository["createModelPortrait"]>[0]): ModelPortraitRecord { return this.models.createModelPortrait(input); }
  public selectModelPortrait(modelId: string, portraitId: string): "selected" | "missing" { return this.models.selectModelPortrait(modelId, portraitId); }
  public deleteModelPortrait(portraitId: string): boolean { return this.models.deleteModelPortrait(portraitId); }
  public listAllModelPortraits(): ModelPortraitRecord[] { return this.models.listAllModelPortraits(); }
  public listModelPortraitsByJobId(jobId: string): ModelPortraitRecord[] { return this.models.listModelPortraitsByJobId(jobId); }

  // ---- patterns / print packs / listing results ----
  public listPatterns(): PatternRecord[] { return this.patterns.listPatterns(); }
  public listPatternsByJobId(jobId: string): PatternRecord[] { return this.patterns.listPatternsByJobId(jobId); }
  public hasPatternArtifactsByJobId(jobId: string): boolean { return this.patterns.hasPatternArtifactsByJobId(jobId); }
  public getPattern(id: string): PatternRecord | undefined { return this.patterns.getPattern(id); }
  public createPattern(input: Parameters<PatternRepository["createPattern"]>[0]): PatternRecord { return this.patterns.createPattern(input); }
  public updatePattern(id: string, patch: Parameters<PatternRepository["updatePattern"]>[1]): PatternRecord | undefined { return this.patterns.updatePattern(id, patch); }
  public deletePattern(id: string): boolean { return this.patterns.deletePattern(id); }
  public setPatternArtifact(id: string, artifact: Parameters<PatternRepository["setPatternArtifact"]>[1]): PatternRecord | undefined { return this.patterns.setPatternArtifact(id, artifact); }
  public setPatternTileable(id: string, verdict: Parameters<PatternRepository["setPatternTileable"]>[1]): PatternRecord | undefined { return this.patterns.setPatternTileable(id, verdict); }
  public createPrintPack(input: Parameters<PatternRepository["createPrintPack"]>[0]): PrintPackRecord { return this.patterns.createPrintPack(input); }
  public getPrintPack(id: string): PrintPackRecord | undefined { return this.patterns.getPrintPack(id); }
  public getPrintPackByJobId(jobId: string): PrintPackRecord | undefined { return this.patterns.getPrintPackByJobId(jobId); }
  public listPrintPacks(patternId: string): PrintPackRecord[] { return this.patterns.listPrintPacks(patternId); }
  public updatePrintPack(id: string, patch: Parameters<PatternRepository["updatePrintPack"]>[1]): PrintPackRecord | undefined { return this.patterns.updatePrintPack(id, patch); }
  public deletePrintPack(id: string): boolean { return this.patterns.deletePrintPack(id); }
  public savePatternListingResult(input: Parameters<PatternRepository["savePatternListingResult"]>[0]): PatternListingResultRecord { return this.patterns.savePatternListingResult(input); }
  public getPatternListingResult(jobId: string): PatternListingResultRecord | undefined { return this.patterns.getPatternListingResult(jobId); }
  public getPatternByDraftCandidateId(candidateId: string): PatternRecord | undefined { return this.patterns.getPatternByDraftCandidateId(candidateId); }

  // ---- pattern drafts ----
  public listPatternDrafts(includeArchived = false): PatternDraftRecord[] { return this.drafts.listDrafts(includeArchived); }
  public getPatternDraft(id: string): PatternDraftRecord | undefined { return this.drafts.getDraft(id); }
  public createPatternDraft(input: Parameters<PatternDraftRepository["createDraft"]>[0]): PatternDraftRecord { return this.drafts.createDraft(input); }
  public updatePatternDraft(id: string, patch: Parameters<PatternDraftRepository["updateDraft"]>[1], expectedRevision: number): UpdateDraftResult { return this.drafts.updateDraft(id, patch, expectedRevision); }
  public setPatternDraftSelectedCandidate(id: string, selectedCandidateId: string | null): PatternDraftRecord | undefined { return this.drafts.setDraftSelectedCandidate(id, selectedCandidateId); }
  public deletePatternDraft(id: string): boolean { return this.drafts.deleteDraft(id); }
  public listDraftMedia(draftId: string): DraftMediaRecord[] { return this.drafts.listMedia(draftId); }
  public getDraftMedia(id: string): DraftMediaRecord | undefined { return this.drafts.getMedia(id); }
  public countDraftMedia(draftId: string, role: Parameters<PatternDraftRepository["countMedia"]>[1]): number { return this.drafts.countMedia(draftId, role); }
  public createDraftMedia(input: Parameters<PatternDraftRepository["createMedia"]>[0]): DraftMediaRecord { return this.drafts.createMedia(input); }
  public updateDraftMedia(id: string, patch: Parameters<PatternDraftRepository["updateMedia"]>[1]): DraftMediaRecord | undefined { return this.drafts.updateMedia(id, patch); }
  public deleteDraftMedia(id: string): boolean { return this.drafts.deleteMedia(id); }
  public listDraftBatches(draftId: string): DraftBatchRecord[] { return this.drafts.listBatches(draftId); }
  public getDraftBatch(id: string): DraftBatchRecord | undefined { return this.drafts.getBatch(id); }
  public getDraftBatchByClientKey(draftId: string, clientKey: string): DraftBatchRecord | undefined { return this.drafts.getBatchByClientKey(draftId, clientKey); }
  public createDraftBatch(input: Parameters<PatternDraftRepository["createBatch"]>[0]): { batch: DraftBatchRecord; slots: DraftSlotRecord[] } { return this.drafts.createBatch(input); }
  public listDraftSlots(batchId: string): DraftSlotRecord[] { return this.drafts.listSlots(batchId); }
  public listDraftSlotsByJobId(jobId: string): DraftSlotRecord[] { return this.drafts.listSlotsByJobId(jobId); }
  public updateDraftSlot(batchId: string, index: number, patch: Parameters<PatternDraftRepository["updateSlot"]>[2]): DraftSlotRecord | undefined { return this.drafts.updateSlot(batchId, index, patch); }
  public assignDraftSlotsToJob(batchId: string, indices: number[], jobId: string, bumpAttempt = true): DraftSlotRecord[] { return this.drafts.assignSlotsToJob(batchId, indices, jobId, bumpAttempt); }
  public listDraftCandidates(draftId: string): DraftCandidateRecord[] { return this.drafts.listCandidates(draftId); }
  public listDraftCandidatesByBatch(batchId: string): DraftCandidateRecord[] { return this.drafts.listCandidatesByBatch(batchId); }
  public getDraftCandidate(id: string): DraftCandidateRecord | undefined { return this.drafts.getCandidate(id); }
  public summarizeDraftCandidates(draftIds: string[]): ReturnType<PatternDraftRepository["summarizeCandidates"]> { return this.drafts.summarizeCandidates(draftIds); }
  public listDraftCandidateSlotIndices(batchId: string): number[] { return this.drafts.listCandidateSlotIndices(batchId); }
  public createDraftCandidate(input: Parameters<PatternDraftRepository["createCandidate"]>[0]): DraftCandidateRecord { return this.drafts.createCandidate(input); }
  public setDraftCandidateTileable(id: string, verdict: Parameters<PatternDraftRepository["setCandidateTileable"]>[1]): DraftCandidateRecord | undefined { return this.drafts.setCandidateTileable(id, verdict); }
  public listChildDraftCandidates(parentCandidateId: string): string[] { return this.drafts.listChildCandidateIds(parentCandidateId); }
  public listDraftParentBatches(draftId: string, candidateId: string): string[] { return this.drafts.listParentBatches(draftId, candidateId); }
  public isDraftStoragePathReferenced(draftId: string, storagePath: string): boolean { return this.drafts.isStoragePathReferenced(draftId, storagePath); }
  public deleteDraftCandidate(id: string): boolean { return this.drafts.deleteCandidate(id); }

  // ---- pattern pipelines ----
  public createPatternPipeline(input: Parameters<PatternPipelineRepository["createPatternPipeline"]>[0]): PatternPipelineWithSteps { return this.pipelines.createPatternPipeline(input); }
  public listPatternPipelines(patternId: string): PatternPipelineWithSteps[] { return this.pipelines.listPatternPipelines(patternId); }
  public getPatternPipeline(id: string): PatternPipelineWithSteps | undefined { return this.pipelines.getPatternPipeline(id); }
  public findReusablePatternPipeline(fingerprint: string): PatternPipelineWithSteps | undefined { return this.pipelines.findReusablePatternPipeline(fingerprint); }
  public updatePatternPipeline(id: string, patch: Parameters<PatternPipelineRepository["updatePatternPipeline"]>[1]): PatternPipelineWithSteps | undefined { return this.pipelines.updatePatternPipeline(id, patch); }
  public getPatternPipelineStepByJobId(jobId: string): PatternPipelineStepRecord | undefined { return this.pipelines.getPatternPipelineStepByJobId(jobId); }
  public updatePatternPipelineStep(id: string, patch: Parameters<PatternPipelineRepository["updatePatternPipelineStep"]>[1]): PatternPipelineStepRecord | undefined { return this.pipelines.updatePatternPipelineStep(id, patch); }

  // ---- projects & planning snapshots ----
  public listProjects(archived = false): ProjectRecord[] { return this.projects.listProjects(archived); }
  public listProjectCovers(projectIds: string[]): Map<string, ProjectCoverSummary> { return this.projects.listProjectCovers(projectIds); }
  public getProject(id: string): ProjectRecord | undefined { return this.projects.getProject(id); }
  public createProject(input: Parameters<ProjectRepository["createProject"]>[0]): ProjectRecord { return this.projects.createProject(input); }
  public updateProject(id: string, patch: Parameters<ProjectRepository["updateProject"]>[1]): ProjectRecord | undefined { return this.projects.updateProject(id, patch); }
  public deleteArchivedProject(id: string): "deleted" | "not_archived" | "missing" { return this.projects.deleteArchivedProject(id); }
  public createPlanningConfigSnapshot(input: Parameters<ProjectRepository["createPlanningConfigSnapshot"]>[0]): PlanningConfigSnapshotRecord { return this.projects.createPlanningConfigSnapshot(input); }
  public listPlanningConfigSnapshots(projectId: string): PlanningConfigSnapshotRecord[] { return this.projects.listPlanningConfigSnapshots(projectId); }
  public getPlanningConfigSnapshot(id: string): PlanningConfigSnapshotRecord | undefined { return this.projects.getPlanningConfigSnapshot(id); }

  // ---- assets ----
  public listAssets(projectId: string): AssetRecord[] { return this.assets.listAssets(projectId); }
  public getAsset(id: string): AssetRecord | undefined { return this.assets.getAsset(id); }
  public createAsset(input: Parameters<AssetRepository["createAsset"]>[0]): AssetRecord { return this.assets.createAsset(input); }
  public deleteAsset(id: string): AssetRecord | undefined { return this.assets.deleteAsset(id); }

  // ---- library view ----
  public listLibraryItems(query?: Parameters<LibraryRepository["listLibraryItems"]>[0]): LibraryItemPage { return this.library.listLibraryItems(query); }
  public findLibrarySourcePath(hash: string): string | undefined { return this.library.findLibrarySourcePath(hash); }
  /**
   * 缩略图惰性生成的统一切入口：按内容 hash 在草稿域与资产库域依次查源文件。
   * 两个域各自只查自己的表，组合放在门面上，避免任一仓储越界读别人的表。
   */
  public findImageSourcePath(hash: string): string | undefined { return this.drafts.findImageSourcePath(hash) ?? this.library.findLibrarySourcePath(hash); }
  public resolveLibrarySource(itemId: string): ReturnType<LibraryRepository["resolveLibrarySource"]> { return this.library.resolveLibrarySource(itemId); }

  // ---- storyboard ----
  public getStoryboard(projectId: string): StoryboardRecord | undefined { return this.storyboards.getStoryboard(projectId); }
  public saveStoryboard(...args: Parameters<StoryboardRepository["saveStoryboard"]>): StoryboardRecord { return this.storyboards.saveStoryboard(...args); }
  public listStoryboardItems(projectId: string): StoryboardItemRecord[] { return this.storyboards.listStoryboardItems(projectId); }
  public getStoryboardItem(id: string): StoryboardItemRecord | undefined { return this.storyboards.getStoryboardItem(id); }
  public deleteStoryboardItem(id: string): StoryboardItemRecord | undefined { return this.storyboards.deleteStoryboardItem(id); }
  public updateStoryboardItem(id: string, patch: Parameters<StoryboardRepository["updateStoryboardItem"]>[1]): StoryboardItemRecord | undefined { return this.storyboards.updateStoryboardItem(id, patch); }
  public confirmStoryboard(projectId: string): StoryboardRecord | undefined { return this.storyboards.confirmStoryboard(projectId); }

  // ---- jobs / copywriting results / web research audit ----
  public createJob(input: Parameters<JobRepository["createJob"]>[0]): JobRecord { return this.jobs.createJob(input); }
  public getJob(id: string): JobRecord | undefined { return this.jobs.getJob(id); }
  public updateJob(id: string, patch: Parameters<JobRepository["updateJob"]>[1]): JobRecord | undefined { return this.jobs.updateJob(id, patch); }
  public findJobByFingerprint(projectId: string | null, fingerprint: string): JobRecord | undefined { return this.jobs.findJobByFingerprint(projectId, fingerprint); }
  public recoverInterruptedJobs(): JobRecord[] { return this.jobs.recoverInterruptedJobs(); }
  public listJobs(projectId: string): JobRecord[] { return this.jobs.listJobs(projectId); }
  public listJobsByType(type: Parameters<JobRepository["listJobsByType"]>[0], limit: number): JobRecord[] { return this.jobs.listJobsByType(type, limit); }
  public countActiveJobs(ownerId: string): number { return this.jobs.countActiveJobs(ownerId); }
  public listJobsByIds(ids: readonly string[]): Map<string, JobRecord> { return this.jobs.listJobsByIds(ids); }
  public saveCopywritingResult(input: Parameters<JobRepository["saveCopywritingResult"]>[0]): CopywritingResultRecord { return this.jobs.saveCopywritingResult(input); }
  public getCopywritingResult(jobId: string): CopywritingResultRecord | undefined { return this.jobs.getCopywritingResult(jobId); }
  public createWebResearchAudit(jobId: string, availability: Parameters<JobRepository["createWebResearchAudit"]>[1]): WebResearchAuditRecord { return this.jobs.createWebResearchAudit(jobId, availability); }
  public recordWebResearchSearch(jobId: string): void { return this.jobs.recordWebResearchSearch(jobId); }
  public recordWebResearchAttempt(input: Parameters<JobRepository["recordWebResearchAttempt"]>[0]): WebResearchAttemptRecord { return this.jobs.recordWebResearchAttempt(input); }
  public getWebResearchAudit(jobId: string): WebResearchAuditRecord | undefined { return this.jobs.getWebResearchAudit(jobId); }
  public listWebResearchAttempts(jobId: string): WebResearchAttemptRecord[] { return this.jobs.listWebResearchAttempts(jobId); }

  // ---- outputs ----
  public createOutput(input: Parameters<OutputRepository["createOutput"]>[0]): OutputRecord { return this.outputs.createOutput(input); }
  public getOutputByGenerationKey(generationKey: string): OutputRecord | undefined { return this.outputs.getOutputByGenerationKey(generationKey); }
  public getOutput(id: string): OutputRecord | undefined { return this.outputs.getOutput(id); }
  public listOutputs(projectId: string): OutputRecord[] { return this.outputs.listOutputs(projectId); }
  public listEditOutputs(sessionId: string): OutputRecord[] { return this.outputs.listEditOutputs(sessionId); }
  public isOutputInEditSession(sessionId: string, outputId: string): boolean { return this.outputs.isOutputInEditSession(sessionId, outputId); }

  // ---- edit sessions / turns / reference assets ----
  public getEditSession(id: string): EditSessionRecord | undefined { return this.editSessions.getEditSession(id); }
  public getActiveEditSession(projectId: string, outputId: string): EditSessionRecord | undefined { return this.editSessions.getActiveEditSession(projectId, outputId); }
  public createEditSession(input: Parameters<EditSessionRepository["createEditSession"]>[0]): EditSessionRecord { return this.editSessions.createEditSession(input); }
  public updateEditSession(id: string, patch: Parameters<EditSessionRepository["updateEditSession"]>[1]): EditSessionRecord | undefined { return this.editSessions.updateEditSession(id, patch); }
  public getEditTurn(id: string): EditTurnRecord | undefined { return this.editSessions.getEditTurn(id); }
  public listEditTurns(sessionId: string): EditTurnRecord[] { return this.editSessions.listEditTurns(sessionId); }
  public createEditTurn(input: Parameters<EditSessionRepository["createEditTurn"]>[0]): EditTurnRecord { return this.editSessions.createEditTurn(input); }
  public updateEditTurn(id: string, patch: Parameters<EditSessionRepository["updateEditTurn"]>[1]): EditTurnRecord | undefined { return this.editSessions.updateEditTurn(id, patch); }
  public listEditReferenceAssets(sessionId: string): EditReferenceAssetRecord[] { return this.editSessions.listEditReferenceAssets(sessionId); }
  public createEditReferenceAsset(input: Parameters<EditSessionRepository["createEditReferenceAsset"]>[0]): EditReferenceAssetRecord { return this.editSessions.createEditReferenceAsset(input); }
  public getEditReferenceAsset(id: string): EditReferenceAssetRecord | undefined { return this.editSessions.getEditReferenceAsset(id); }
  public deleteEditReferenceAsset(id: string): void { return this.editSessions.deleteEditReferenceAsset(id); }
  public attachEditReferenceAssets(sessionId: string, turnId: string, ids: string[]): void { return this.editSessions.attachEditReferenceAssets(sessionId, turnId, ids); }
  public listExpiredEditReferenceAssets(at?: Parameters<EditSessionRepository["listExpiredEditReferenceAssets"]>[0]): EditReferenceAssetRecord[] { return this.editSessions.listExpiredEditReferenceAssets(at); }

  // ---- exports & layer plans/exports ----
  public createExport(input: Parameters<ExportRepository["createExport"]>[0]): ExportRecord { return this.exports.createExport(input); }
  public getExport(id: string): ExportRecord | undefined { return this.exports.getExport(id); }
  public getExportByJobId(jobId: string): ExportRecord | undefined { return this.exports.getExportByJobId(jobId); }
  public updateExport(id: string, patch: Parameters<ExportRepository["updateExport"]>[1]): ExportRecord | undefined { return this.exports.updateExport(id, patch); }
  public createLayerPlan(input: Parameters<ExportRepository["createLayerPlan"]>[0]): LayerPlanRecord { return this.exports.createLayerPlan(input); }
  public getLayerPlan(id: string): LayerPlanRecord | undefined { return this.exports.getLayerPlan(id); }
  public getLayerPlanByOutput(outputId: string): LayerPlanRecord | undefined { return this.exports.getLayerPlanByOutput(outputId); }
  public getLayerPlanByJobId(jobId: string): LayerPlanRecord | undefined { return this.exports.getLayerPlanByJobId(jobId); }
  public updateLayerPlan(id: string, patch: Parameters<ExportRepository["updateLayerPlan"]>[1]): LayerPlanRecord | undefined { return this.exports.updateLayerPlan(id, patch); }
  public createLayerExport(input: Parameters<ExportRepository["createLayerExport"]>[0]): LayerExportRecord { return this.exports.createLayerExport(input); }
  public getLayerExport(id: string): LayerExportRecord | undefined { return this.exports.getLayerExport(id); }
  public getLayerExportByJobId(jobId: string): LayerExportRecord | undefined { return this.exports.getLayerExportByJobId(jobId); }
  public getLayerExportByOutput(outputId: string): LayerExportRecord | undefined { return this.exports.getLayerExportByOutput(outputId); }
  public listLayerExportsByOutput(outputId: string): LayerExportRecord[] { return this.exports.listLayerExportsByOutput(outputId); }
  public updateLayerExport(id: string, patch: Parameters<ExportRepository["updateLayerExport"]>[1]): LayerExportRecord | undefined { return this.exports.updateLayerExport(id, patch); }

  // ---- users / sessions ----
  public createUser(input: Parameters<UserRepository["createUser"]>[0]): UserRecord { return this.users.createUser(input); }
  public getUser(id: string): UserRecord | undefined { return this.users.getUser(id); }
  public getUserByEmail(email: string): UserRecord | undefined { return this.users.getUserByEmail(normalizeEmail(email)); }
  public countUsers(): number { return this.users.countUsers(); }
  public listUsers(query: UserListQuery): { items: UserRecord[]; total: number } { return this.users.listUsers(query); }
  public updateUser(id: string, patch: Partial<Pick<UserRecord, "displayName" | "role" | "status" | "passwordHash" | "emailVerifiedAt">>): UserRecord | undefined { return this.users.updateUser(id, patch); }
  public deleteUser(id: string): boolean { return this.users.deleteUser(id); }
  public createSession(input: Parameters<UserRepository["createSession"]>[0]): SessionRecord { return this.users.createSession(input); }
  public findActiveSession(tokenHash: string): { session: SessionRecord; user: UserRecord } | undefined { return this.users.findActiveSession(tokenHash); }
  public touchSession(id: string): void { return this.users.touchSession(id); }
  public revokeSession(id: string): void { return this.users.revokeSession(id); }
  public deleteExpiredSessions(nowIso: string): number { return this.users.deleteExpiredSessions(nowIso); }

  public revokeUserSessions(userId: string): number { return this.users.revokeUserSessions(userId); }
  public listUserSessions(userId: string): SessionRecord[] { return this.users.listUserSessions(userId); }
  public createPasswordResetToken(userId: string, tokenHash: string, expiresAt: string): string { return this.users.createPasswordResetToken(userId, tokenHash, expiresAt); }
  public consumePasswordResetToken(tokenHash: string): string | undefined { return this.users.consumePasswordResetToken(tokenHash); }

  // ---- audit / login events / settings ----
  public recordLoginEvent(input: LoginEventInput): void { return this.users.recordLoginEvent(input); }
  public listLoginEvents(limit: number, offset: number, userId?: string): Record<string, unknown>[] { return this.users.listLoginEvents(limit, offset, userId); }
  public recordAuditEvent(input: AuditEventInput): void { return this.users.recordAuditEvent(input); }
  public listAuditEvents(limit: number, offset: number): Record<string, unknown>[] { return this.users.listAuditEvents(limit, offset); }
  public getSetting<T>(key: string, fallback: T): T { return this.users.getSetting(key, fallback); }
  public setSetting(key: string, value: unknown): void { return this.users.setSetting(key, value); }
  public claimOrphanRows(ownerId: string): Record<string, number> { return this.users.claimOrphanRows(ownerId); }

  // ---- credits ----
  public getBalance(userId: string): number { return this.credits.getBalance(userId); }
  public applyCreditEntry(input: CreditEntryInput, options?: { allowNegative?: boolean }): ReturnType<CreditRepository["applyEntry"]> { return this.credits.applyEntry(input, options); }
  public listCreditLedger(userId: string, limit: number, offset: number): CreditEntryRecord[] { return this.credits.listLedger(userId, limit, offset); }
  public countCreditLedger(userId: string): number { return this.credits.countLedger(userId); }
  public recomputeBalance(userId: string): { stored: number; computed: number } { return this.credits.recomputeBalance(userId); }
  public setBalance(userId: string, balanceMicrocredits: number): void { return this.credits.setBalance(userId, balanceMicrocredits); }

  // ---- plans / subscriptions / entitlements ----
  public listPlans(includeInactive = false): PlanRecord[] { return this.plans.listPlans(includeInactive); }
  public getPlan(id: string): PlanRecord | undefined { return this.plans.getPlan(id); }
  public getPlanByCode(code: string): PlanRecord | undefined { return this.plans.getPlanByCode(code); }
  public upsertPlan(input: Parameters<PlanRepository["upsertPlan"]>[0]): PlanRecord { return this.plans.upsertPlan(input); }
  public getActiveSubscription(userId: string): SubscriptionRecord | undefined { return this.plans.getActiveSubscription(userId); }
  public listSubscriptions(limit: number, offset: number): SubscriptionRecord[] { return this.plans.listSubscriptions(limit, offset); }
  public activateSubscription(input: Parameters<PlanRepository["activateSubscription"]>[0]): SubscriptionRecord { return this.plans.activateSubscription(input); }
  public updateSubscription(id: string, patch: Partial<Pick<SubscriptionRecord, "status" | "currentPeriodStart" | "currentPeriodEnd" | "cancelAtPeriodEnd">>): SubscriptionRecord | undefined { return this.plans.updateSubscription(id, patch); }
  public resolveEntitlements(user: Pick<UserRecord, "id" | "role">): { entitlements: Entitlements; planCode: string } { return this.plans.resolveEntitlements(user); }

  // ---- billing / prices ----
  public createBillingReservation(input: Parameters<BillingRepository["createReservation"]>[0]): BillingOrderRecord { return this.billing.createReservation(input); }
  public getBillingOrder(id: string): BillingOrderRecord | undefined { return this.billing.getBillingOrder(id); }
  public getBillingOrderByJob(jobId: string): BillingOrderRecord | undefined { return this.billing.getByJobId(jobId); }
  public transitionBillingOrder(id: string, status: Exclude<BillingStatus, "reserved">, settledMicrocredits?: number, from?: BillingStatus): BillingOrderRecord | undefined { return this.billing.transition(id, status, settledMicrocredits, from); }
  public listBillingOrders(userId: string, limit: number, offset: number): BillingOrderRecord[] { return this.billing.listByUser(userId, limit, offset); }
  /** 僵尸预扣：订单仍 reserved，但任务已终态或已不存在。 */
  public listStaleReservations(): BillingOrderRecord[] { return this.billing.listStaleReservations(); }
  public listUncertainBillingOrders(limit: number, offset: number): BillingOrderRecord[] { return this.billing.listUncertain(limit, offset); }
  public getProviderModelPrice(providerId: string, modelId: string, kind: string): ProviderModelPriceRecord | undefined { return this.billing.getPrice(providerId, modelId, kind); }
  public listProviderModelPrices(): ProviderModelPriceRecord[] { return this.billing.listPrices(); }
  public upsertProviderModelPrice(input: Parameters<BillingRepository["upsertPrice"]>[0]): ProviderModelPriceRecord { return this.billing.upsertPrice(input); }
  public deleteProviderModelPrice(id: string): boolean { return this.billing.deletePrice(id); }

  // ---- payments ----
  public createPaymentOrder(input: Parameters<PaymentRepository["createOrder"]>[0]): PaymentOrderRecord { return this.payments.createOrder(input); }
  public getPaymentOrder(id: string): PaymentOrderRecord | undefined { return this.payments.getOrder(id); }
  public getPaymentOrderByProviderNo(provider: string, providerOrderNo: string): PaymentOrderRecord | undefined { return this.payments.getOrderByProviderNo(provider, providerOrderNo); }
  public updatePaymentOrder(id: string, patch: Partial<Pick<PaymentOrderRecord, "status" | "providerOrderNo" | "providerTradeNo" | "paidAt" | "creditedAt">>): PaymentOrderRecord | undefined { return this.payments.updateOrder(id, patch); }
  public listPaymentOrders(userId: string, limit: number, offset: number): PaymentOrderRecord[] { return this.payments.listByUser(userId, limit, offset); }
  public listAllPaymentOrders(limit: number, offset: number, status?: PaymentOrderStatus): PaymentOrderRecord[] { return this.payments.listOrders(limit, offset, status); }
  public recordPaymentNotification(input: Parameters<PaymentRepository["recordNotification"]>[0]): { duplicate: boolean; id: string } { return this.payments.recordNotification(input); }
  public markPaymentNotification(id: string, status: PaymentNotificationStatus, error?: unknown): void { return this.payments.markNotification(id, status, error); }
  public listPaymentNotifications(limit: number, offset: number): Record<string, unknown>[] { return this.payments.listNotifications(limit, offset); }
  public creditPaymentOrderOnce(orderId: string, credit: (order: PaymentOrderRecord) => void): ReturnType<PaymentRepository["creditOrderOnce"]> { return this.payments.creditOrderOnce(orderId, credit); }

  // ---- admin overview ----
  public adminOverview(): AdminOverview { return this.admin.overview(); }
  public listPaidButNotCredited(limit: number, offset: number): Record<string, unknown>[] { return this.admin.paidButNotCredited(limit, offset); }
  public listExpiredUnpaid(now: string, limit: number, offset: number): Record<string, unknown>[] { return this.admin.expiredUnpaid(now, limit, offset); }

  // ---- storage accounting ----
  public usedStorageBytes(ownerId: string): number { return this.storage.usedBytes(ownerId); }
  public recordStorageSize(table: SizedTable, id: string, sizeBytes: number): void { return this.storage.recordSize(table, id, sizeBytes); }
  public recountStorage(dataDir: string): { updated: number; missing: number } { return this.storage.recount(dataDir); }
}
