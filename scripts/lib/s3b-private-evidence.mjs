// Explicit private-file I/O only; importing this module performs no operation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ReconciliationError } from './s3b-reconciliation.mjs';

export function assertRestricted(filename) {
  if (process.platform!=='win32') {
    const stat=fs.statSync(filename);
    if ((stat.mode&0o077)!==0 || stat.uid!==process.getuid()) throw new ReconciliationError('private_permissions_required');
    return;
  }
  // Paths travel through an environment value, never interpolated PowerShell.
  const check=String.raw`$ErrorActionPreference='Stop'
$taskSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskAcl=Get-Acl -LiteralPath $env:MAPPR_PRIVATE_PERMISSION_PATH
foreach($taskRule in $taskAcl.Access) {
 $taskPrincipal=$taskRule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
 if($taskRule.AccessControlType -eq 'Allow' -and ($taskRule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadData) -and $taskPrincipal -notin @($taskSid,'S-1-5-18','S-1-5-32-544')) { exit 1 }
}`;
  try { execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',check],
    {env:{...process.env,MAPPR_PRIVATE_PERMISSION_PATH:filename},stdio:'pipe',timeout:15000}); }
  catch { throw new ReconciliationError('private_permissions_required'); }
}

export function privateEvidencePath(filename) {
  if (!filename || !path.isAbsolute(filename)) throw new ReconciliationError('private_evidence_path_required');
  const resolved=fs.existsSync(filename)?fs.realpathSync(filename):path.join(fs.realpathSync(path.dirname(filename)),path.basename(filename));
  const repo=fs.realpathSync(fileURLToPath(new URL('../../',import.meta.url)));
  const relative=path.relative(repo,resolved);
  if (relative==='' || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative))) throw new ReconciliationError('evidence_must_be_outside_repository');
  return resolved;
}

export class FileEvidenceStore {
  constructor(filename) { this.filename=privateEvidencePath(filename); assertRestricted(path.dirname(this.filename)); }
  async read() {
    if (!fs.existsSync(this.filename)) return null;
    assertRestricted(this.filename);
    if (!fs.statSync(this.filename).isFile() || fs.statSync(this.filename).size>16*1024*1024) throw new ReconciliationError('invalid_evidence');
    try { return JSON.parse(fs.readFileSync(this.filename,'utf8')); }
    catch { throw new ReconciliationError('invalid_evidence'); }
  }
  async save(value) {
    // Never overwrite original recovery evidence. Failure stops before DB DML;
    // retain a partial file for private operator review rather than deleting it.
    const payload=JSON.stringify(value);
    if (Buffer.byteLength(payload)>16*1024*1024) throw new ReconciliationError('invalid_evidence');
    const fd=fs.openSync(this.filename,'wx',0o600);
    try { assertRestricted(this.filename); fs.writeFileSync(fd,payload); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (process.platform!=='win32') {
      const dir=fs.openSync(path.dirname(this.filename),'r');try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
  }
}
