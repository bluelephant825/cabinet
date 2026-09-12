import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { readWikiCabinet, WIKI_STATE_PATH } from "./config";
import { SourceStore } from "./source-store";
import { RawPublicationStore } from "./raw-publication";
import { encodeSourceManifest, type SourceManifest } from "./manifest";
import { ownedPath, statOrNull, withRootLock, contains } from "./filesystem";
import { durableText, readWikiInventory, textHash } from "./wiki-publication";

export async function resolveLegacyRawPath(root: string, selected: string) {
  const file = await ownedPath(root, `${WIKI_STATE_PATH}/raw-path-aliases.json`);
  if (!await statOrNull(file)) return selected;
  const aliases = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, string>;
  const old = Object.keys(aliases).find((from) => contains(from, selected));
  return old ? aliases[old] + selected.slice(old.length) : selected;
}

/** Explicit maintenance operation. Run with ingestion paused. A full pre-change
 * backup is retained, and the journal records an interrupted migration for review. */
export async function migrateRawLayout(root: string) {
  return withRootLock(root, async () => {
    const cabinet = await readWikiCabinet(root);
    if (!cabinet) throw new Error("Wiki is not initialized");
    const journal = `${WIKI_STATE_PATH}/raw-layout-migration.json`;
    const journalFile = await ownedPath(root, journal);
    if (await statOrNull(journalFile) && JSON.parse(await fs.readFile(journalFile, "utf8")).status !== "complete") throw new Error("An interrupted Raw layout migration requires recovery from its recorded backup");
    const publications = await ownedPath(root, `${WIKI_STATE_PATH}/wiki-publications`);
    if (await statOrNull(publications)) for (const name of await fs.readdir(publications)) {
      if (name.endsWith(".json") && JSON.parse(await fs.readFile(path.join(publications, name), "utf8")).status !== "complete") throw new Error("Finish pending Wiki publication before reorganizing Raw");
    }
    const entries = await new SourceStore(root).list();
    const moves = entries.filter(({ source }) => source.mode === "managed" && source.managedLocation.kind === "cabinet" && !source.mirroredFrom).map((entry) => {
      const source = entry.source;
      if (source.mode !== "managed" || source.managedLocation.kind !== "cabinet") throw new Error("Invalid source");
      return { entry, from: source.rawPath, to: `${cabinet.config.paths.raw}/${source.managedLocation.path.replace(/\.(md|markdown)$/i, "")}`, original: source.managedLocation.path };
    });
    if (!moves.length) return { migrated: 0 };
    const publisher = new RawPublicationStore(root);
    for (const move of moves) {
      if (await statOrNull(await ownedPath(root, move.to))) throw new Error(`Destination exists: ${move.to}`);
      if (moves.some((other) => other !== move && (contains(move.to, other.to) || contains(other.to, move.to)))) throw new Error("Conflicting mirrored source paths");
      for (const version of move.entry.versions) {
        const receipt = JSON.parse(await fs.readFile(await ownedPath(root, `${WIKI_STATE_PATH}/publications/${move.entry.source.id}/v${version.version}/receipt.json`), "utf8"));
        for (const file of receipt.files) await publisher.readCapturedFile(move.entry.source.id, version.id, file.path);
      }
    }
    const inventory = await readWikiInventory(root);
    for (const item of inventory) if (textHash(await fs.readFile(await ownedPath(root, item.provenance.pagePath), "utf8")) !== item.markdownHash) throw new Error("Review edited Wiki pages before migration");
    const backup = `${WIKI_STATE_PATH}/raw-layout-backups/${randomUUID()}`;
    const backupPath = await ownedPath(root, backup);
    await fs.mkdir(backupPath, { recursive: true });
    const saved = [cabinet.config.paths.raw, cabinet.config.paths.wiki, `${WIKI_STATE_PATH}/publications`, `${WIKI_STATE_PATH}/wiki-inventory.json`, `${WIKI_STATE_PATH}/raw-path-aliases.json`];
    for (const file of saved) {
      const from = await ownedPath(root, file);
      if (await statOrNull(from)) { const target = path.join(backupPath, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.cp(from, target, { recursive: true, errorOnExist: true }); }
    }
    await durableText(root, journal, JSON.stringify({ status: "prepared", backup, moves: moves.map(({ from, to }) => ({ from, to })) }));
    const aliasesFile = await ownedPath(root, `${WIKI_STATE_PATH}/raw-path-aliases.json`);
    const aliases = await statOrNull(aliasesFile) ? JSON.parse(await fs.readFile(aliasesFile, "utf8")) : {};
    const staging = `${backup}/moving`;
    await fs.mkdir(await ownedPath(root, staging));
    for (const move of moves) await fs.rename(await ownedPath(root, move.from), await ownedPath(root, `${staging}/${move.entry.source.id}`));
    for (const move of moves) {
      for (let parent = path.dirname(path.join(root, move.from)); parent !== path.join(root, cabinet.config.paths.raw); parent = path.dirname(parent)) {
        if (!await statOrNull(parent)) continue;
        if ((await fs.readdir(parent)).length) break;
        await fs.rmdir(parent);
      }
    }
    for (const move of moves) {
      const rebase = (manifest: SourceManifest) => {
        manifest.source.rawPath = move.to; manifest.source.mirroredFrom = move.original;
        manifest.versions = manifest.versions.map((version) => ({ ...version,
          originalPath: version.originalPath.replace(move.from, move.to),
          markdownPath: version.markdownPath.replace(move.from, move.to),
          ...(version.assetsPath ? { assetsPath: version.assetsPath.replace(move.from, move.to) } : {}),
        }));
        return encodeSourceManifest(manifest, cabinet);
      };
      await fs.mkdir(path.dirname(await ownedPath(root, move.to)), { recursive: true });
      await fs.rename(await ownedPath(root, `${staging}/${move.entry.source.id}`), await ownedPath(root, move.to));
      await durableText(root, `${move.to}/manifest.yaml`, rebase(move.entry));
      for (const version of move.entry.versions) {
        const receiptPath = `${WIKI_STATE_PATH}/publications/${move.entry.source.id}/v${version.version}/receipt.json`;
        const receipt = JSON.parse(await fs.readFile(await ownedPath(root, receiptPath), "utf8"));
        receipt.manifest = rebase(yaml.load(receipt.manifest, { schema: yaml.JSON_SCHEMA }) as SourceManifest);
        if (["md", "markdown"].includes(version.originalFormat)) {
          const capturePath = `${move.to}/v${version.version}/capture.json`;
          const capture = JSON.parse(await fs.readFile(await ownedPath(root, capturePath), "utf8"));
          if (capture.original.startsWith("capture/")) {
            const originalCopy = await ownedPath(root, `${move.to}/v${version.version}/${capture.original}`);
            await fs.unlink(originalCopy);
            receipt.files = receipt.files.filter((file: { path: string }) => file.path !== capture.original);
            for (let parent = path.dirname(originalCopy); parent !== path.join(root, move.to, `v${version.version}`); parent = path.dirname(parent)) {
              if ((await fs.readdir(parent)).length) break;
              await fs.rmdir(parent);
            }
            const text = JSON.stringify({ ...capture, original: `original.${version.originalFormat}` }) + "\n";
            await durableText(root, capturePath, text);
            const file = receipt.files.find((file: { path: string }) => file.path === "capture.json");
            file.sha256 = textHash(text); file.size = Buffer.byteLength(text);
          }
        }
        await durableText(root, receiptPath, JSON.stringify(receipt));
      }
      aliases[move.from] = move.to;
      for (let parent = path.dirname(path.join(root, move.from)); parent !== path.join(root, cabinet.config.paths.raw); parent = path.dirname(parent)) {
        if (!await statOrNull(parent)) continue;
        if ((await fs.readdir(parent)).length) break;
        await fs.rmdir(parent);
      }
    }
    // Generated pages have already passed inventory checks. Only citation targets
    // change; claims, support edges and captured evidence bytes remain identical.
    for (const [index, item] of inventory.entries()) {
      const target = await ownedPath(root, item.provenance.pagePath);
      let text = await fs.readFile(target, "utf8");
      for (const move of moves) text = text.split(move.from.split("/").map(encodeURIComponent).join("/")).join(move.to.split("/").map(encodeURIComponent).join("/"));
      await durableText(root, item.provenance.pagePath, text); inventory[index] = { ...item, markdownHash: textHash(text) };
    }
    await durableText(root, `${WIKI_STATE_PATH}/wiki-inventory.json`, JSON.stringify(inventory));
    await durableText(root, `${WIKI_STATE_PATH}/raw-path-aliases.json`, JSON.stringify(aliases));
    for (const move of moves) for (const version of move.entry.versions) await publisher.readCapturedFile(move.entry.source.id, version.id, "source.md");
    await durableText(root, journal, JSON.stringify({ status: "complete", backup, moves: moves.map(({ from, to }) => ({ from, to })) }));
    return { migrated: moves.length, backup };
  });
}
