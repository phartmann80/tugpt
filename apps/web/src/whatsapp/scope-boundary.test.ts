import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural / static guardrails for the Phase 3A scope boundary. These are
 * not behavioral tests of a running system -- they assert on the source
 * tree itself, which is the only reliable way to prove a negative like
 * "no code path exists" without executing a live integration.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FORBIDDEN_IMPORTS = ['@tugpt/ai-providers', 'mastra', 'logicc', 'langdock'];

function listFilesRecursive(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist' || entry === '.turbo') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      listFilesRecursive(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extracts only the module specifiers of import/require statements --
 * deliberately ignores comments and string literals elsewhere in the file
 * (this file's own doc comments legitimately name Mastra/Logicc/Langdock to
 * document that they are NOT imported, which must not trip this check).
 */
function extractImportedModules(source: string): string[] {
  const modules: string[] = [];
  const importRe = /(?:import\s+(?:[\s\S]*?\s+from\s+)?|require\()\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source)) !== null) {
    modules.push(match[1]);
  }
  return modules;
}

describe('Phase 3A webhook route scope boundary', () => {
  it('the webhook route has one atomic ingestion boundary and no split table/enqueue path', () => {
    const routeFile = join(REPO_ROOT, 'apps/web/src/app/api/v1/webhooks/whatsapp/route.ts');
    const source = readFileSync(routeFile, 'utf-8');

    expect(source).toContain('.ingestWhatsAppMessageEvent(');
    expect(source).not.toMatch(/\.from\(['"](?:webhook_events|inbound_message_staging)['"]\)/);
    expect(source).not.toContain(".enqueue('whatsapp.process_message'");
  });

  it('the webhook route file imports no AI provider, orchestration, Mastra, Logicc, or Langdock package', () => {
    const routeFile = join(REPO_ROOT, 'apps/web/src/app/api/v1/webhooks/whatsapp/route.ts');
    const imports = extractImportedModules(readFileSync(routeFile, 'utf-8')).map((m) => m.toLowerCase());

    for (const forbidden of FORBIDDEN_IMPORTS) {
      expect(imports.some((m) => m.includes(forbidden.toLowerCase()))).toBe(false);
    }
  });

  it('the worker inbound processor imports no AI provider, orchestration, Mastra, Logicc, or Langdock package', () => {
    const processorFile = join(REPO_ROOT, 'apps/worker/src/whatsapp-inbound-processor.ts');
    const imports = extractImportedModules(readFileSync(processorFile, 'utf-8')).map((m) => m.toLowerCase());

    for (const forbidden of FORBIDDEN_IMPORTS) {
      expect(imports.some((m) => m.includes(forbidden.toLowerCase()))).toBe(false);
    }
  });

  it('the worker entrypoint imports no AI provider, orchestration, Mastra, Logicc, or Langdock package', () => {
    const indexFile = join(REPO_ROOT, 'apps/worker/src/index.ts');
    const imports = extractImportedModules(readFileSync(indexFile, 'utf-8')).map((m) => m.toLowerCase());

    for (const forbidden of FORBIDDEN_IMPORTS) {
      expect(imports.some((m) => m.includes(forbidden.toLowerCase()))).toBe(false);
    }
  });

  it('no file under apps/web or apps/worker references sending a WhatsApp message outbound', () => {
    const searchRoots = [join(REPO_ROOT, 'apps/web/src'), join(REPO_ROOT, 'apps/worker/src')];
    const offenders: string[] = [];

    for (const root of searchRoots) {
      for (const file of listFilesRecursive(root)) {
        const source = readFileSync(file, 'utf-8');
        // Looks for an actual outbound-send call shape, not just the word
        // "send" (which appears legitimately in "sendMessage" comments about
        // what is NOT yet implemented, "senderror", etc.) -- specifically the
        // WhatsApp Cloud API's outbound send endpoint path.
        if (/graph\.facebook\.com\/[^"'\s]*\/messages/.test(source) && !file.endsWith('.test.ts')) {
          offenders.push(file);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('@tugpt/ai-providers is not a dependency of apps/web or apps/worker package.json', () => {
    const webPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/web/package.json'), 'utf-8'));
    const workerPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/worker/package.json'), 'utf-8'));

    const webDeps = { ...webPkg.dependencies, ...webPkg.devDependencies };
    const workerDeps = { ...workerPkg.dependencies, ...workerPkg.devDependencies };

    expect(webDeps['@tugpt/ai-providers']).toBeUndefined();
    expect(workerDeps['@tugpt/ai-providers']).toBeUndefined();
  });
});
