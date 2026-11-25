import {execFile} from 'node:child_process';
import {lstatSync, realpathSync, unlinkSync} from 'node:fs';
import {lstat, open, readdir, realpath} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {promisify} from 'node:util';

const uuid = /^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/u;
const prefix = '.ovis-in-use-';
type Reservation = {release: () => void};
type OwnedReservation = Reservation & {assertValid: () => void};
type Claim = {users: number; pending: Promise<OwnedReservation>};
const claims = new Map<string, Claim>();
let bootSession: Promise<string> | undefined;

function currentBootSession(): Promise<string> {
  return bootSession ??= promisify(execFile)('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'],
    {encoding: 'utf8', timeout: 5000, maxBuffer: 1024}).then(result => result.stdout.trim());
}

/** A host crash cannot release this marker. Only a confirmed exit or a different OS boot can. */
export async function acquireOvisOperationReservation(root: string,
  readBootSession: () => Promise<string> = currentBootSession): Promise<Reservation> {
  let claim = claims.get(root);
  if (!claim) {
    claim = {users: 0, pending: createReservation(root, readBootSession)};
    claims.set(root, claim);
  }
  claim.users++;
  const current = claim;
  let reservation: OwnedReservation;
  try {reservation = await current.pending; reservation.assertValid();}
  catch (error) {
    if (--current.users === 0) claims.delete(root);
    throw error;
  }
  let released = false;
  return {release: () => {
    if (released) return;
    if (current.users === 1) {
      // Synchronous identity check/unlink keeps a new acquisition from sharing a
      // marker that is being removed. Failed cleanup keeps the claim reserved.
      reservation.release();
      claims.delete(root);
    }
    current.users--; released = true;
  }};
}

async function createReservation(root: string, readBootSession: () => Promise<string>): Promise<OwnedReservation> {
  const boot = await readBootSession();
  if (!uuid.test(boot)) throw new Error('research_ovis_boot_identity_invalid');
  const parent = await lstat(root);
  if (!isAbsolute(root) || !parent.isDirectory() || parent.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error('research_ovis_reservation_directory_invalid');
  }
  const assertParent = (): void => {
    const info = lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== parent.dev || info.ino !== parent.ino ||
        realpathSync(root) !== root) throw new Error('research_ovis_reservation_directory_changed');
  };
  // No process from a previous boot can still use these files. Never infer that
  // from a missing host PID: the independently supervised Worker may outlive it.
  for (const name of await readdir(root)) {
    const oldBoot = name.slice(prefix.length);
    if (!name.startsWith(prefix) || !uuid.test(oldBoot) || oldBoot === boot) continue;
    assertParent();
    const path = join(root, name), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== 0 || (info.mode & 0o777) !== 0o600) {
      throw new Error('research_ovis_reservation_marker_invalid');
    }
    unlinkSync(path);
  }
  assertParent();
  const path = join(root, `${prefix}${boot}`);
  let file;
  try {file = await open(path, 'wx', 0o600);}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('research_ovis_previous_operation_unresolved');
    throw error;
  }
  const owner = await file.stat();
  try {await file.sync();}
  finally {await file.close();}
  assertParent();
  const assertValid = (): void => {
    assertParent();
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== 0 ||
        info.dev !== owner.dev || info.ino !== owner.ino) throw new Error('research_ovis_reservation_marker_changed');
  };
  return {assertValid, release: () => {assertValid(); unlinkSync(path);}};
}
