import {link, lstat, mkdir, open, realpath, rm, unlink} from 'node:fs/promises';
import type {Stats} from 'node:fs';
import {basename, isAbsolute, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ovisModelIdentitySchema} from '../../../shared/schemas/research-ovis';
import {inspectOvisInstallation, type OvisInstallationInspection} from './ovis-model-store';
import {prepareOvisInstallation, type OvisInstallationInput, type OvisInstallationProgress} from './ovis-installation';
import {readResearchFile} from './research-files';
import {acquireOvisOperationReservation} from './ovis-operation-reservation';
import {hasUnprovenResearchProcessExit} from './process-exit-state';

const ownerSchema = z.object({device: z.number().int().nonnegative(), inode: z.number().int().positive()}).strict();
type Owner = z.infer<typeof ownerSchema>;
const owner = (info: Stats): Owner => ({device: info.dev, inode: info.ino});
const sameOwner = (first: Owner, second: Owner): boolean => first.device === second.device && first.inode === second.inode;
const fileIdentity = (info: Stats): string =>
  [info.dev, info.ino, info.size, info.mode, info.mtimeMs, info.ctimeMs].join(':');
const selectionSchema = z.object({version: z.literal(1), generation: z.string().regex(/^ovis-install-[A-Za-z0-9]{6}$/u),
  parent: ownerSchema, directory: ownerSchema,
  pythonBase: z.string().refine(isAbsolute), identity: ovisModelIdentitySchema}).strict();
type Selection = z.infer<typeof selectionSchema>;
type Selected = {value: Selection; file: string};
type SharedState = {mutation: boolean; quarantined: boolean; readers: number; progress: OvisInstallationProgress | null; directory: Owner | null};
const states = new Map<string, SharedState>();
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
type Dependencies = {prepare: typeof prepareOvisInstallation; inspect: typeof inspectOvisInstallation};

/** One main process owns model lifecycle. All instances for the same canonical root share reservations. */
export class OvisInstallationManager {
  private readonly state: SharedState;
  constructor(private readonly root: string, private readonly specification: string,
    private readonly dependencies: Dependencies = {prepare: prepareOvisInstallation, inspect: inspectOvisInstallation}) {
    if (!isAbsolute(root) || !isAbsolute(specification)) throw new Error('research_ovis_absolute_path_required');
    const existing = states.get(root);
    this.state = existing ?? {mutation: false, quarantined: false, readers: 0, progress: null, directory: null};
    if (!existing) states.set(root, this.state);
  }

  get busy(): boolean {return this.state.mutation || this.state.quarantined || this.state.readers !== 0;}
  get progress(): OvisInstallationProgress | null {return this.state.progress ? {...this.state.progress} : null;}

  private async directory(create: boolean): Promise<Owner | null> {
    let info;
    try {info = await lstat(this.root);}
    catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      if (this.state.directory) throw new Error('research_ovis_installation_directory_changed');
      if (!create) return null;
      await mkdir(this.root, {recursive: true, mode: 0o700});
      info = await lstat(this.root);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.root) !== this.root) {
      throw new Error('research_ovis_installation_directory_invalid');
    }
    const current = owner(info);
    if (this.state.directory && !sameOwner(this.state.directory, current)) {
      throw new Error('research_ovis_installation_directory_changed');
    }
    this.state.directory = current;
    return current;
  }

  private async selection(): Promise<Selected | null> {
    const parent = await this.directory(false);
    if (!parent) return null;
    let info;
    try {info = await lstat(join(this.root, 'active.json'));}
    catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      await this.directory(false);
      return null;
    }
    const value = selectionSchema.parse(JSON.parse((await readResearchFile(this.root, 'active.json', 16 * 1024)).toString('utf8')));
    if (!sameOwner(parent, value.parent)) throw new Error('research_ovis_installation_directory_changed');
    const selected = {value, file: fileIdentity(info)};
    await this.assertSelectionFile(selected);
    return selected;
  }

  private async assertSelectionFile(selected: Selected): Promise<void> {
    await this.directory(false);
    const info = await lstat(join(this.root, 'active.json'));
    if (!info.isFile() || info.isSymbolicLink() || fileIdentity(info) !== selected.file) {
      throw new Error('research_ovis_installation_selection_changed');
    }
  }

  private async ownedGeneration(selection: Selection, missingAllowed = false): Promise<string | null> {
    const parent = await this.directory(false);
    if (!parent || !sameOwner(parent, selection.parent)) throw new Error('research_ovis_installation_directory_changed');
    const path = join(this.root, selection.generation);
    let info;
    try {info = await lstat(path);}
    catch (error) {if (missingAllowed && errorCode(error) === 'ENOENT') return null; throw error;}
    if (!info.isDirectory() || info.isSymbolicLink() || !sameOwner(owner(info), selection.directory) ||
        await realpath(path) !== path) throw new Error('research_ovis_installation_generation_changed');
    return path;
  }

  private installation(selection: Selection) {
    const root = join(this.root, selection.generation);
    return {root, pythonBase: selection.pythonBase, inferenceScript: join(root, 'spec/infer.py'), identity: selection.identity};
  }

  /** Presence is not readiness: acquire performs complete verification before supplying a lease. */
  async installed(): Promise<boolean> {
    if (this.state.mutation || this.state.quarantined) throw new Error('research_ovis_installation_busy');
    this.state.readers++;
    let reservation: Awaited<ReturnType<typeof acquireOvisOperationReservation>> | undefined;
    try {
      if (!await this.directory(false)) return false;
      reservation = await acquireOvisOperationReservation(this.root);
      return (await this.selection()) !== null;
    } finally {reservation?.release(); this.state.readers--;}
  }

  async acquire(signal: AbortSignal): Promise<OvisInstallationInspection & {release: () => void}> {
    signal.throwIfAborted();
    if (this.state.mutation || this.state.quarantined) throw new Error('research_ovis_installation_busy');
    this.state.readers++;
    let reservation: Awaited<ReturnType<typeof acquireOvisOperationReservation>> | undefined;
    let released = false;
    const release = (): void => {if (!released) {reservation?.release(); released = true; this.state.readers--;}};
    try {
      if (!await this.directory(false)) throw new Error('research_ovis_installation_missing');
      reservation = await acquireOvisOperationReservation(this.root);
      const selection = await this.selection();
      if (!selection) throw new Error('research_ovis_installation_missing');
      await this.ownedGeneration(selection.value);
      const result = await this.dependencies.inspect(this.installation(selection.value), signal);
      await this.ownedGeneration(selection.value);
      await this.assertSelectionFile(selection);
      signal.throwIfAborted();
      return {...result, release};
    } catch (error) {release(); throw error;}
  }

  async install(input: Omit<OvisInstallationInput, 'parent' | 'specification'>): Promise<OvisInstallationInspection> {
    input.signal.throwIfAborted();
    if (this.busy) throw new Error('research_ovis_installation_busy');
    this.state.mutation = true;
    let prepared: Selection | null = null, published = false, temporaryOwner: Owner | null = null;
    let reservation: Awaited<ReturnType<typeof acquireOvisOperationReservation>> | undefined;
    let failure: unknown;
    const temporary = join(this.root, `.active-${randomUUID()}.json`);
    try {
      const parent = (await this.directory(true))!;
      reservation = await acquireOvisOperationReservation(this.root);
      if (await this.selection()) throw new Error('research_ovis_installation_already_selected');
      const result = await this.dependencies.prepare({...input, parent: this.root, specification: this.specification,
        onProgress: progress => {this.state.progress = {...progress}; input.onProgress?.({...progress});}});
      const installation = result.installation, name = basename(installation.root);
      if (installation.root !== join(this.root, name) || installation.inferenceScript !== join(installation.root, 'spec/infer.py')) {
        throw new Error('research_ovis_installation_preparation_invalid');
      }
      const info = await lstat(installation.root);
      prepared = selectionSchema.parse({version: 1, generation: name, parent, directory: owner(info),
        pythonBase: installation.pythonBase, identity: installation.identity});
      await this.ownedGeneration(prepared);
      input.signal.throwIfAborted();
      const file = await open(temporary, 'wx', 0o600);
      try {
        temporaryOwner = owner(await file.stat());
        await file.writeFile(JSON.stringify(prepared) + '\n');
        await file.sync();
      } finally {await file.close();}
      input.signal.throwIfAborted();
      await this.ownedGeneration(prepared);
      // This is the commit point. Cancellation after successful publication cannot undo a ready selection.
      await link(temporary, join(this.root, 'active.json'));
      published = true;
      return result;
    } catch (error) {
      failure = error;
      if (hasUnprovenResearchProcessExit(error)) this.state.quarantined = true;
      throw error;
    }
    finally {
      const errors: unknown[] = [];
      try {
        if (temporaryOwner) try {
          await this.directory(false);
          const info = await lstat(temporary);
          if (!info.isFile() || info.isSymbolicLink() || !sameOwner(owner(info), temporaryOwner)) {
            throw new Error('research_ovis_installation_temporary_changed');
          }
          await unlink(temporary);
        } catch (error) {errors.push(error);}
        if (prepared && !published && !this.state.quarantined) {
          try {
            const owned = await this.ownedGeneration(prepared, true);
            if (owned) await rm(owned, {recursive: true});
          } catch (error) {errors.push(error);}
        }
      } finally {
        if (!this.state.quarantined) try {reservation?.release();} catch (error) {this.state.quarantined = true; errors.push(error);}
        this.state.progress = null; this.state.mutation = false;
      }
      if (errors.length) throw new AggregateError(failure === undefined ? errors : [failure, ...errors],
        'research_ovis_installation_cleanup_failed');
    }
  }

  /** Explicit user removal only. A damaged payload can be deleted; changed root identity cannot. */
  async remove(): Promise<void> {
    if (this.busy) throw new Error('research_ovis_installation_busy');
    this.state.mutation = true;
    let reservation: Awaited<ReturnType<typeof acquireOvisOperationReservation>> | undefined;
    try {
      if (!await this.directory(false)) return;
      reservation = await acquireOvisOperationReservation(this.root);
      const selection = await this.selection();
      if (!selection) return;
      const root = await this.ownedGeneration(selection.value, true);
      // Keep the selection until deletion completes. Interrupted deletion can be explicitly retried.
      if (root) await rm(root, {recursive: true});
      await this.assertSelectionFile(selection);
      await unlink(join(this.root, 'active.json'));
    } finally {
      try {reservation?.release();}
      catch (error) {this.state.quarantined = true; throw error;}
      finally {this.state.mutation = false;}
    }
  }
}
