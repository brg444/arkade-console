#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
function loadRegistry() {
  return JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf-8"));
}
let REGISTRY = loadRegistry();

// Reload registry when the file changes
import { watch } from "fs";
watch(join(ROOT, "registry.json"), () => {
  try { REGISTRY = loadRegistry(); } catch {}
});
const CACHE_DIR = join(ROOT, ".repo-cache");
const SNAPSHOT_DIR = join(ROOT, ".snapshots");

// --- Snapshot persistence ---

function saveSnapshot(project, snapshot, tag) {
  const dir = join(SNAPSHOT_DIR, project);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data = { tag, timestamp: new Date().toISOString(), surface: snapshot };
  writeFileSync(join(dir, "latest.json"), JSON.stringify(data, null, 2));
}

function loadSnapshot(project) {
  const path = join(SNAPSHOT_DIR, project, "latest.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

// --- Repo management ---

function ensureRepo(projectId) {
  const project = REGISTRY.projects[projectId];
  if (!project) throw new Error(`Unknown project: ${projectId}`);

  const repoDir = join(CACHE_DIR, projectId);
  if (existsSync(join(repoDir, ".git"))) {
    // Pull latest (quiet, don't fail if offline)
    try {
      execSync("git fetch origin --quiet && git reset --hard origin/HEAD --quiet", {
        cwd: repoDir,
        stdio: "ignore",
        timeout: 15000,
      });
    } catch {}
    return repoDir;
  }

  // Clone
  execSync(`git clone --depth 1 --tags https://github.com/${project.repo}.git ${repoDir}`, {
    stdio: "ignore",
    timeout: 60000,
  });
  return repoDir;
}

function repoExists(projectId) {
  const repoDir = join(CACHE_DIR, projectId);
  return existsSync(join(repoDir, ".git"));
}

function isShallowClone(repoDir) {
  try {
    return execSync("git rev-parse --is-shallow-repository", {
      cwd: repoDir, encoding: "utf-8", timeout: 5000,
    }).trim() === "true";
  } catch {
    return false;
  }
}

function ensureUnshallow(repoDir) {
  if (!isShallowClone(repoDir)) return;
  execSync("git fetch --unshallow --quiet", {
    cwd: repoDir,
    stdio: "ignore",
    timeout: 120000,
  });
}

// --- Extraction helpers ---

function extractTypeScriptExports(repoDir, filePath) {
  const fullPath = join(repoDir, filePath);
  if (!existsSync(fullPath)) return `File not found: ${filePath}`;
  const content = readFileSync(fullPath, "utf-8");

  // Extract export statements, interfaces, types, classes
  const lines = content.split("\n");
  const exports = [];
  let inBlock = false;
  let blockDepth = 0;
  let blockLines = [];

  for (const line of lines) {
    if (
      line.match(
        /^export\s+(interface|type|class|function|const|enum|abstract)/
      ) ||
      line.match(/^export\s+\{/) ||
      line.match(/^export\s+default/)
    ) {
      inBlock = true;
      blockDepth = 0;
      blockLines = [];
    }

    if (inBlock) {
      blockLines.push(line);
      blockDepth += (line.match(/\{/g) || []).length;
      blockDepth -= (line.match(/\}/g) || []).length;

      if (blockDepth <= 0 && blockLines.length > 0) {
        exports.push(blockLines.join("\n"));
        inBlock = false;
        blockLines = [];
      }

      // Safety: don't capture enormous blocks
      if (blockLines.length > 80) {
        exports.push(blockLines.slice(0, 5).join("\n") + "\n  // ... truncated");
        inBlock = false;
        blockLines = [];
      }
    }
  }

  // Also capture re-exports
  const reExports = lines.filter((l) => l.match(/^export\s+\{.*\}\s+from/));
  if (reExports.length > 0 && !exports.some((e) => e.includes("from"))) {
    exports.push("// Re-exports\n" + reExports.join("\n"));
  }

  return exports.join("\n\n") || "No exports found";
}

function extractGoInterfaces(repoDir, filePath) {
  const fullPath = join(repoDir, filePath);
  if (!existsSync(fullPath)) return `File not found: ${filePath}`;
  const content = readFileSync(fullPath, "utf-8");

  const lines = content.split("\n");
  const blocks = [];
  let inBlock = false;
  let blockLines = [];

  for (const line of lines) {
    if (line.match(/^type\s+\w+\s+(struct|interface)\s*\{/) || line.match(/^func\s+/)) {
      inBlock = true;
      blockLines = [line];
      if (!line.includes("{") || line.trim().endsWith("}")) {
        blocks.push(blockLines.join("\n"));
        inBlock = false;
        blockLines = [];
      }
      continue;
    }

    if (inBlock) {
      blockLines.push(line);
      if (line.match(/^\}/) || line.trim() === "}") {
        blocks.push(blockLines.join("\n"));
        inBlock = false;
        blockLines = [];
      }
      if (blockLines.length > 80) {
        blocks.push(
          blockLines.slice(0, 5).join("\n") + "\n  // ... truncated"
        );
        inBlock = false;
        blockLines = [];
      }
    }
  }

  return blocks.join("\n\n") || "No type definitions or functions found";
}

function extractRustExports(repoDir, filePath) {
  const fullPath = join(repoDir, filePath);
  if (!existsSync(fullPath)) return `File not found: ${filePath}`;
  const content = readFileSync(fullPath, "utf-8");

  const lines = content.split("\n");
  const blocks = [];
  let inBlock = false;
  let blockDepth = 0;
  let blockLines = [];

  for (const line of lines) {
    if (
      line.match(/^pub\s+(async\s+)?fn\s+/) ||
      line.match(/^pub\s+(struct|enum|trait|type|const|mod|static)\s+/) ||
      line.match(/^pub\s+\(\s*crate\s*\)\s+(fn|struct|enum|trait|type)\s+/)
    ) {
      inBlock = true;
      blockDepth = 0;
      blockLines = [line];

      // Single-line declarations (no block body)
      if (!line.includes("{") || (line.includes("{") && line.includes("}"))) {
        if (!line.includes("{")) {
          blocks.push(blockLines.join("\n"));
          inBlock = false;
          blockLines = [];
        }
      }
      continue;
    }

    if (inBlock) {
      blockLines.push(line);
      blockDepth += (line.match(/\{/g) || []).length;
      blockDepth -= (line.match(/\}/g) || []).length;

      if (blockDepth <= 0 && blockLines.some((l) => l.includes("{"))) {
        blocks.push(blockLines.join("\n"));
        inBlock = false;
        blockLines = [];
      }

      if (blockLines.length > 80) {
        blocks.push(blockLines.slice(0, 5).join("\n") + "\n  // ... truncated");
        inBlock = false;
        blockLines = [];
      }
    }
  }

  return blocks.join("\n\n") || "No public exports found";
}

function extractCSharpInterfaces(repoDir, filePath) {
  const fullPath = join(repoDir, filePath);
  if (!existsSync(fullPath)) return `File not found: ${filePath}`;
  const content = readFileSync(fullPath, "utf-8");

  const lines = content.split("\n");
  const blocks = [];
  let inBlock = false;
  let blockDepth = 0;
  let blockLines = [];

  for (const line of lines) {
    if (
      line.match(/^\s*public\s+(abstract\s+|static\s+|sealed\s+|partial\s+)*(class|interface|struct|enum|record)\s+/) ||
      line.match(/^\s*namespace\s+/)
    ) {
      inBlock = true;
      blockDepth = 0;
      blockLines = [line];
      continue;
    }

    if (inBlock) {
      blockLines.push(line);
      blockDepth += (line.match(/\{/g) || []).length;
      blockDepth -= (line.match(/\}/g) || []).length;

      if (blockDepth <= 0 && blockLines.some((l) => l.includes("{"))) {
        blocks.push(blockLines.join("\n"));
        inBlock = false;
        blockLines = [];
      }

      if (blockLines.length > 80) {
        blocks.push(blockLines.slice(0, 5).join("\n") + "\n  // ... truncated");
        inBlock = false;
        blockLines = [];
      }
    }
  }

  return blocks.join("\n\n") || "No public types found";
}

function readDirectory(repoDir, dirPath) {
  const fullPath = join(repoDir, dirPath);
  if (!existsSync(fullPath)) return `Directory not found: ${dirPath}`;

  try {
    const entries = readdirSync(fullPath, { withFileTypes: true });
    return entries
      .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
      .join("\n");
  } catch (e) {
    return `Error reading directory: ${e.message}`;
  }
}

const DEFAULT_EXCLUDES = new Set([
  "node_modules", ".git", "dist", "build", ".next", "target",
  "vendor", "__pycache__", ".cache", "coverage", "bin", "obj",
]);

function buildTree(baseDir, currentPath, maxDepth, includeExts, currentDepth = 0) {
  const fullPath = join(baseDir, currentPath);
  if (!existsSync(fullPath) || !statSync(fullPath).isDirectory()) return [];
  if (currentDepth > maxDepth) return [{ path: currentPath + "/", truncated: true }];

  let entries;
  try {
    entries = readdirSync(fullPath, { withFileTypes: true });
  } catch { return []; }

  const results = [];
  const dirs = entries.filter(e => e.isDirectory() && !DEFAULT_EXCLUDES.has(e.name) && !e.name.startsWith("."));
  const files = entries.filter(e => e.isFile());

  for (const dir of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
    const dirPath = join(currentPath, dir.name);
    results.push({ path: dirPath + "/", type: "d" });
    results.push(...buildTree(baseDir, dirPath, maxDepth, includeExts, currentDepth + 1));
  }

  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    if (includeExts && !includeExts.some(ext => file.name.endsWith(ext))) continue;
    results.push({ path: join(currentPath, file.name), type: "f" });
  }

  return results;
}

function findSimilarPaths(repoDir, missingPath) {
  const suggestions = [];
  const basename = missingPath.split("/").pop();
  const ext = basename.includes(".") ? basename.split(".").pop() : null;

  // Strategy 1: find basename anywhere in repo
  try {
    const findType = ext ? "" : "-type d";
    const cmd = `find . ${findType} -name ${JSON.stringify(basename)} -not -path "./.git/*" -not -path "*/node_modules/*" | head -5`;
    const result = execSync(cmd, { cwd: repoDir, encoding: "utf-8", timeout: 5000 }).trim();
    if (result) suggestions.push(...result.split("\n").map(p => p.replace(/^\.\//, "")));
  } catch {}

  // Strategy 2: list parent directory contents for similar names
  const parentPath = missingPath.split("/").slice(0, -1).join("/");
  if (parentPath) {
    const parentFull = join(repoDir, parentPath);
    if (existsSync(parentFull) && statSync(parentFull).isDirectory()) {
      const entries = readdirSync(parentFull);
      const target = basename.toLowerCase();
      const similar = entries.filter(e => {
        const lower = e.toLowerCase();
        return lower.includes(target) || target.includes(lower) ||
               (target.length >= 3 && lower.startsWith(target.slice(0, 3)));
      });
      suggestions.push(...similar.map(s => join(parentPath, s)));
    }
  }

  // Strategy 3: search for same name with different extension
  if (ext) {
    try {
      const nameNoExt = basename.replace(`.${ext}`, "");
      const result = execSync(
        `find . -name ${JSON.stringify(nameNoExt + ".*")} -not -path "./.git/*" -not -path "*/node_modules/*" | head -5`,
        { cwd: repoDir, encoding: "utf-8", timeout: 5000 }
      ).trim();
      if (result) suggestions.push(...result.split("\n").map(p => p.replace(/^\.\//, "")));
    } catch {}
  }

  return [...new Set(suggestions)].slice(0, 5);
}

const BUILTIN_SKIP = new Set([
  "console", "log", "fmt", "context", "error", "require", "import",
  "Promise", "Error", "string", "number", "boolean", "void", "null",
  "undefined", "true", "false", "Math", "JSON", "Date", "Array",
  "Object", "Map", "Set", "Buffer", "process", "module", "exports",
  "describe", "test", "expect", "beforeEach", "afterEach",
  "http", "sync", "time", "testing", "bytes",
]);

function extractCodeBlocks(markdownContent) {
  const blocks = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let match;
  let blockIndex = 0;
  while ((match = regex.exec(markdownContent)) !== null) {
    blockIndex++;
    const language = match[1].toLowerCase();
    const code = match[2];
    const line = markdownContent.slice(0, match.index).split("\n").length;
    blocks.push({ language, code, line, index: blockIndex });
  }
  return blocks;
}

function extractImportsFromCodeBlock(code, language) {
  const symbols = [];

  if (["typescript", "ts", "javascript", "js", "tsx", "jsx"].includes(language)) {
    // import { Foo, Bar } from "..."
    for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'][^"']*["']/g)) {
      symbols.push(...m[1].split(",").map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean));
    }
    // import Foo from "..."
    for (const m of code.matchAll(/import\s+(\w+)\s+from\s*["']/g)) {
      symbols.push(m[1]);
    }
    // new Foo( or Foo.bar(
    for (const m of code.matchAll(/(?:new\s+)(\w+)[\s(]/g)) {
      symbols.push(m[1]);
    }
    for (const m of code.matchAll(/(\w+)\.\w+\s*\(/g)) {
      symbols.push(m[1]);
    }
  } else if (["go", "golang"].includes(language)) {
    // pkg.FunctionName(
    for (const m of code.matchAll(/(\w+)\.([A-Z]\w+)\s*[({]/g)) {
      symbols.push(m[2]);
    }
    // Type references: &SomeType{}, var x SomeType
    for (const m of code.matchAll(/[&*]?(\b[A-Z]\w{3,})\b/g)) {
      symbols.push(m[1]);
    }
  } else if (["rust", "rs"].includes(language)) {
    // use crate::module::Type
    for (const m of code.matchAll(/use\s+[\w:]+::(\w+)/g)) {
      symbols.push(m[1]);
    }
    // Type::method(
    for (const m of code.matchAll(/(\w+)::\w+\s*\(/g)) {
      symbols.push(m[1]);
    }
  }

  return [...new Set(symbols)].filter(s => s.length >= 4 && !BUILTIN_SKIP.has(s));
}

function sanitizeGlob(glob) {
  // Allow only safe glob characters: alphanumeric, *, ?, ., /, -, _
  if (!glob || !/^[a-zA-Z0-9*?.\/_\-{}]+$/.test(glob)) return null;
  return glob;
}

function searchInRepo(repoDir, query, glob) {
  const safeGlob = glob ? sanitizeGlob(glob) : null;
  if (glob && !safeGlob) {
    return "Invalid glob pattern. Use only alphanumeric, *, ?, ., /, -, _ characters.";
  }

  // Try ripgrep first, fall back to grep
  const commands = [
    `rg --no-heading -n -C 1 --max-count 20 ${safeGlob ? `--glob ${JSON.stringify(safeGlob)}` : ""} -- ${JSON.stringify(query)}`,
    `grep -rn --include=${safeGlob ? JSON.stringify(safeGlob) : "'*'"} -C 1 ${JSON.stringify(query)} .`,
  ];

  for (const cmd of commands) {
    try {
      const result = execSync(cmd, {
        cwd: repoDir,
        encoding: "utf-8",
        timeout: 10000,
      });
      const lines = result.split("\n");
      if (lines.length > 200) {
        return lines.slice(0, 200).join("\n") + `\n... (${lines.length - 200} more lines)`;
      }
      return result;
    } catch (e) {
      if (e.status === 1) return "No matches found";
      // If command not found, try next
      if (e.message.includes("not found") || e.message.includes("ENOENT")) continue;
      return `Search error: ${e.message}`;
    }
  }
  return "No search tool available (install ripgrep for best results)";
}

function getGitLog(repoDir, count = 15) {
  try {
    return execSync(
      `git log --oneline --no-decorate -n ${count}`,
      { cwd: repoDir, encoding: "utf-8", timeout: 5000 }
    );
  } catch {
    return "Could not read git log";
  }
}

function getLatestTag(repoDir) {
  try {
    // Get the most recent tag by version sorting
    const result = execSync(
      "git tag -l --sort=-v:refname | head -1",
      { cwd: repoDir, encoding: "utf-8", timeout: 5000 }
    ).trim();
    return result || "no tags";
  } catch {
    return "unknown";
  }
}

// --- API drift detection ---

function snapshotApiSurface(repoDir, project) {
  const proj = REGISTRY.projects[project];
  if (!proj) return {};

  const snapshot = {};
  for (const [name, entryPath] of Object.entries(proj.entry_points)) {
    const fullPath = join(repoDir, entryPath);
    if (!existsSync(fullPath)) continue;

    if (statSync(fullPath).isFile()) {
      if (proj.language === "typescript" || entryPath.endsWith(".ts")) {
        snapshot[name] = extractTypeScriptExports(repoDir, entryPath);
      } else if (proj.language === "go" || entryPath.endsWith(".go")) {
        snapshot[name] = extractGoInterfaces(repoDir, entryPath);
      } else if (proj.language === "rust" || entryPath.endsWith(".rs")) {
        snapshot[name] = extractRustExports(repoDir, entryPath);
      } else if (proj.language === "csharp" || entryPath.endsWith(".cs")) {
        snapshot[name] = extractCSharpInterfaces(repoDir, entryPath);
      }
    } else {
      // Directory: extract from all source files
      const sourceExtensions = [".ts", ".go", ".rs", ".cs"];
      const files = readdirSync(fullPath).filter(
        (f) => sourceExtensions.some((ext) => f.endsWith(ext))
      );
      const parts = files.slice(0, 10).map((f) => {
        const fp = join(entryPath, f);
        if (f.endsWith(".ts")) return extractTypeScriptExports(repoDir, fp);
        if (f.endsWith(".go")) return extractGoInterfaces(repoDir, fp);
        if (f.endsWith(".rs")) return extractRustExports(repoDir, fp);
        if (f.endsWith(".cs")) return extractCSharpInterfaces(repoDir, fp);
        return "";
      });
      snapshot[name] = parts.filter(Boolean).join("\n\n");
    }
  }
  return snapshot;
}

function diffSnapshots(before, after) {
  const changes = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    if (!before[key] && after[key]) {
      changes.push({ module: key, type: "added", detail: "New module" });
    } else if (before[key] && !after[key]) {
      changes.push({ module: key, type: "removed", detail: "Module removed" });
    } else if (before[key] !== after[key]) {
      // Find specific changes
      const beforeLines = new Set(before[key].split("\n"));
      const afterLines = new Set(after[key].split("\n"));
      const added = [...afterLines].filter((l) => !beforeLines.has(l) && l.trim());
      const removed = [...beforeLines].filter((l) => !afterLines.has(l) && l.trim());

      if (added.length > 0 || removed.length > 0) {
        changes.push({
          module: key,
          type: "changed",
          added: added.slice(0, 20),
          removed: removed.slice(0, 20),
        });
      }
    }
  }
  return changes;
}

function findDocsReferences(docsDir, symbols) {
  if (!existsSync(docsDir)) return [];

  const hits = [];
  for (const symbol of symbols) {
    // Strip noise to get the core identifier
    const match = symbol.match(
      /(?:export\s+)?(?:class|interface|type|function|const|enum)\s+(\w+)/
    );
    if (!match) continue;
    const name = match[1];
    if (name.length < 4) continue; // Skip short names

    try {
      const result = execSync(
        `grep -rl --include='*.mdx' --include='*.md' ${JSON.stringify(name)} .`,
        { cwd: docsDir, encoding: "utf-8", timeout: 5000 }
      );
      const files = result.trim().split("\n").filter(Boolean);
      if (files.length > 0) {
        hits.push({ symbol: name, docs_files: files });
      }
    } catch {}
  }
  return hits;
}

// --- MCP Server ---

const server = new McpServer({
  name: "arkade-mcp",
  version: "0.1.0",
});

// Tool: get_api_surface
server.tool(
  "get_api_surface",
  "Extract public API surface (exports, types, interfaces) from a specific module in an Arkade repo. Clones/caches the repo automatically.",
  {
    project: z
      .string()
      .describe(
        "Project ID from registry (e.g. ts-sdk, go-sdk, arkd, boltz-swap)"
      ),
    module: z
      .string()
      .describe(
        "Module name matching an entry_point key (e.g. exports, identity, wallet, types, client) or a direct file path"
      ),
  },
  async ({ project, module }) => {
    const proj = REGISTRY.projects[project];
    if (!proj) {
      const available = Object.keys(REGISTRY.projects).join(", ");
      return {
        content: [
          { type: "text", text: `Unknown project: ${project}\nAvailable: ${available}` },
        ],
      };
    }

    let repoDir;
    try {
      repoDir = ensureRepo(project);
    } catch (e) {
      return {
        content: [
          { type: "text", text: `Failed to clone ${project}: ${e.message}` },
        ],
      };
    }
    const entryPath = proj.entry_points[module] || module;

    let result;
    const fullPath = join(repoDir, entryPath);

    if (existsSync(fullPath) && statSync(fullPath).isFile()) {
      // It's a file
      if (proj.language === "typescript" || entryPath.endsWith(".ts") || entryPath.endsWith(".tsx")) {
        result = extractTypeScriptExports(repoDir, entryPath);
      } else if (proj.language === "go" || entryPath.endsWith(".go")) {
        result = extractGoInterfaces(repoDir, entryPath);
      } else if (proj.language === "rust" || entryPath.endsWith(".rs")) {
        result = extractRustExports(repoDir, entryPath);
      } else if (proj.language === "csharp" || entryPath.endsWith(".cs")) {
        result = extractCSharpInterfaces(repoDir, entryPath);
      } else {
        result = readFileSync(fullPath, "utf-8").slice(0, 10000);
      }
    } else if (existsSync(fullPath)) {
      // It's a directory: list contents and extract from key files
      const listing = readDirectory(repoDir, entryPath);
      const sourceExtensions = [".ts", ".go", ".rs", ".cs"];
      const files = readdirSync(fullPath).filter(
        (f) => sourceExtensions.some((ext) => f.endsWith(ext))
      );

      const extractions = files.slice(0, 8).map((f) => {
        const fp = join(entryPath, f);
        if (proj.language === "typescript" || f.endsWith(".ts")) {
          return `// --- ${f} ---\n${extractTypeScriptExports(repoDir, fp)}`;
        } else if (proj.language === "go" || f.endsWith(".go")) {
          return `// --- ${f} ---\n${extractGoInterfaces(repoDir, fp)}`;
        } else if (proj.language === "rust" || f.endsWith(".rs")) {
          return `// --- ${f} ---\n${extractRustExports(repoDir, fp)}`;
        } else if (proj.language === "csharp" || f.endsWith(".cs")) {
          return `// --- ${f} ---\n${extractCSharpInterfaces(repoDir, fp)}`;
        }
        return "";
      });

      result = `Directory: ${entryPath}\n${listing}\n\n${extractions.filter(Boolean).join("\n\n")}`;
    } else {
      const suggestions = findSimilarPaths(repoDir, entryPath);
      if (suggestions.length > 0) {
        result = `Path not found: ${entryPath}\n\nDid you mean:\n${suggestions.map(s => `  - ${s}`).join("\n")}\n\nUpdate registry.json entry_points to fix permanently.`;
      } else {
        result = `Path not found: ${entryPath}\n\nNo similar paths found. The module may have been removed. Use search_repos or tree to locate it.`;
      }
    }

    const tag = getLatestTag(repoDir);
    const header = `# ${project} — ${module}\nLatest tag: ${tag}\nRepo: ${proj.repo}\n\n`;

    return { content: [{ type: "text", text: header + result }] };
  }
);

// Tool: search_repos
server.tool(
  "search_repos",
  "Search for a pattern across one or more Arkade repos using ripgrep. Returns matching lines with context.",
  {
    query: z.string().describe("Search pattern (regex supported)"),
    projects: z
      .array(z.string())
      .optional()
      .describe(
        "Project IDs to search. Omit to search all cached repos."
      ),
    glob: z
      .string()
      .optional()
      .describe("File glob filter (e.g. '*.ts', '*.go')"),
  },
  async ({ query, projects, glob }) => {
    const targetProjects =
      projects || Object.keys(REGISTRY.projects).filter((p) => repoExists(p));

    if (targetProjects.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No repos cached yet. Use get_api_surface or get_project_info first to clone a repo.",
          },
        ],
      };
    }

    const results = [];
    for (const projectId of targetProjects) {
      const proj = REGISTRY.projects[projectId];
      if (!proj) continue;

      let repoDir;
      try {
        repoDir = ensureRepo(projectId);
      } catch {
        results.push(`# ${projectId}: clone failed`);
        continue;
      }

      const searchResult = searchInRepo(repoDir, query, glob);
      if (searchResult && searchResult !== "No matches found") {
        results.push(`# ${projectId} (${proj.repo})\n${searchResult}`);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: results.length > 0
            ? results.join("\n\n---\n\n")
            : `No matches for "${query}" in ${targetProjects.join(", ")}`,
        },
      ],
    };
  }
);

// Tool: get_project_info
server.tool(
  "get_project_info",
  "Get project overview: context doc (architecture, conventions), recent git activity, latest version, and directory structure.",
  {
    project: z.string().describe("Project ID from registry"),
  },
  async ({ project }) => {
    const proj = REGISTRY.projects[project];
    if (!proj) {
      const available = Object.keys(REGISTRY.projects).join(", ");
      return {
        content: [
          { type: "text", text: `Unknown project: ${project}\nAvailable: ${available}` },
        ],
      };
    }

    const parts = [`# ${project}\n${proj.description}\nRepo: ${proj.repo}\nLanguage: ${proj.language}`];

    // Context doc
    const contextPath = join(ROOT, "context", `${project}.md`);
    if (existsSync(contextPath)) {
      parts.push(`## Context\n${readFileSync(contextPath, "utf-8")}`);
    }

    // Live repo info
    if (repoExists(project)) {
      const repoDir = ensureRepo(project);
      const tag = getLatestTag(repoDir);
      const log = getGitLog(repoDir);
      parts.push(`## Latest version: ${tag}\n\n## Recent commits\n${log}`);

      // Top-level directory listing
      const listing = readDirectory(repoDir, ".");
      parts.push(`## Directory structure\n${listing}`);

      // Check for CLAUDE.md in repo
      const claudePath = join(repoDir, "CLAUDE.md");
      if (existsSync(claudePath)) {
        parts.push(
          `## CLAUDE.md (from repo)\n${readFileSync(claudePath, "utf-8")}`
        );
      }
    } else {
      parts.push(
        "\n(Repo not cached yet. This tool will clone it on first access.)"
      );
      try {
        ensureRepo(project);
        const repoDir = join(CACHE_DIR, project);
        const tag = getLatestTag(repoDir);
        const log = getGitLog(repoDir);
        parts.push(`## Latest version: ${tag}\n\n## Recent commits\n${log}`);
      } catch (e) {
        parts.push(`Clone failed: ${e.message}`);
      }
    }

    // Entry points
    parts.push(
      `## Entry points\n${Object.entries(proj.entry_points)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n")}`
    );

    return { content: [{ type: "text", text: parts.join("\n\n") }] };
  }
);

// Tool: read_file
server.tool(
  "read_file",
  "Read a specific file from an Arkade repo. Useful for checking exact implementations. Supports offset/limit for large files.",
  {
    project: z.string().describe("Project ID from registry"),
    path: z.string().describe("File path relative to repo root"),
    offset: z.number().optional().describe("Line number to start from (0-based). Omit to read from start."),
    limit: z.number().optional().describe("Max number of lines to return. Defaults to all lines (truncated at 15000 chars)."),
  },
  async ({ project, path: filePath, offset, limit }) => {
    const proj = REGISTRY.projects[project];
    if (!proj) {
      return {
        content: [{ type: "text", text: `Unknown project: ${project}` }],
      };
    }

    let repoDir;
    try {
      repoDir = ensureRepo(project);
    } catch (e) {
      return {
        content: [{ type: "text", text: `Failed to clone ${project}: ${e.message}` }],
      };
    }

    const fullPath = join(repoDir, filePath);

    if (!existsSync(fullPath)) {
      const suggestions = findSimilarPaths(repoDir, filePath);
      const msg = suggestions.length > 0
        ? `File not found: ${filePath}\n\nDid you mean:\n${suggestions.map(s => `  - ${s}`).join("\n")}`
        : `File not found: ${filePath}`;
      return {
        content: [{ type: "text", text: msg }],
      };
    }

    if (statSync(fullPath).isDirectory()) {
      const listing = readDirectory(repoDir, filePath);
      return {
        content: [{ type: "text", text: `Directory: ${filePath}\n${listing}\n\nUse a specific file path to read file contents.` }],
      };
    }

    const raw = readFileSync(fullPath, "utf-8");
    let content = raw;
    let meta = "";

    if (offset !== undefined || limit !== undefined) {
      const lines = raw.split("\n");
      const start = offset || 0;
      const end = limit ? start + limit : lines.length;
      content = lines.slice(start, end).join("\n");
      meta = `\n[Lines ${start + 1}-${Math.min(end, lines.length)} of ${lines.length}]`;
    }

    if (content.length > 15000) {
      return {
        content: [
          {
            type: "text",
            text: content.slice(0, 15000) + `\n\n... truncated (${raw.length} chars total)${meta}`,
          },
        ],
      };
    }

    return { content: [{ type: "text", text: content + meta }] };
  }
);

// Tool: list_projects
server.tool(
  "list_projects",
  "List all projects in the Arkade registry with their repos and descriptions.",
  {},
  async () => {
    const lines = Object.entries(REGISTRY.projects).map(
      ([id, p]) => `**${id}** (${p.repo}) [${p.language}]\n  ${p.description}`
    );
    return {
      content: [
        {
          type: "text",
          text: `# Arkade Projects\n\n${lines.join("\n\n")}`,
        },
      ],
    };
  }
);

// Tool: check_docs_drift
server.tool(
  "check_docs_drift",
  "Detect API changes between the cached version and current source, then flag docs pages that reference changed symbols. Run this after SDK releases to find docs that need updating.",
  {
    project: z.string().describe("Project ID (e.g. ts-sdk, go-sdk)"),
    docs_path: z
      .string()
      .optional()
      .describe(
        "Path to docs repo on disk. Defaults to the arkade-docs cache."
      ),
  },
  async ({ project, docs_path }) => {
    const proj = REGISTRY.projects[project];
    if (!proj) {
      return {
        content: [
          { type: "text", text: `Unknown project: ${project}` },
        ],
      };
    }

    // Pull latest
    let repoDir;
    try {
      repoDir = ensureRepo(project);
    } catch (e) {
      return { content: [{ type: "text", text: `Failed to access ${project}: ${e.message}` }] };
    }

    const newTag = getLatestTag(repoDir);

    // Snapshot current state
    const after = snapshotApiSurface(repoDir, project);

    // Load previous snapshot from disk (persisted from last run)
    const saved = loadSnapshot(project);
    let before, oldTag, baselineNote;

    if (saved) {
      before = saved.surface;
      oldTag = saved.tag;
      baselineNote = `Baseline: ${saved.tag} (saved ${saved.timestamp})`;
    } else {
      // No saved snapshot: first run. Save current as baseline and report.
      saveSnapshot(project, after, newTag);
      return {
        content: [{
          type: "text",
          text: `# API Drift Report: ${project}\n\nFirst run. Saved current API surface as baseline (${newTag}).\nRun again after code changes to detect drift.`,
        }],
      };
    }

    // Diff against saved baseline
    const changes = diffSnapshots(before, after);

    // Always save current as new baseline
    saveSnapshot(project, after, newTag);

    if (changes.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `# API Drift Report: ${project}\n\nNo API surface changes detected.\n${baselineNote}\nCurrent: ${newTag}`,
          },
        ],
      };
    }

    // Find docs references
    const docsDir =
      docs_path || (repoExists("arkade-docs") ? join(CACHE_DIR, "arkade-docs") : null);

    const changedSymbols = changes.flatMap((c) => [
      ...(c.added || []),
      ...(c.removed || []),
    ]);

    let docsHits = [];
    if (docsDir) {
      docsHits = findDocsReferences(docsDir, changedSymbols);
    }

    // Format report
    const parts = [
      `# API Drift Report: ${project}`,
      baselineNote,
      `Current: ${newTag}`,
      `Changes detected in ${changes.length} module(s)`,
      "",
    ];

    for (const change of changes) {
      parts.push(`## ${change.module} (${change.type})`);
      if (change.removed?.length) {
        parts.push("Removed:");
        change.removed.forEach((l) => parts.push(`  - ${l.trim()}`));
      }
      if (change.added?.length) {
        parts.push("Added:");
        change.added.forEach((l) => parts.push(`  + ${l.trim()}`));
      }
      parts.push("");
    }

    if (docsHits.length > 0) {
      parts.push("## Docs pages to review");
      for (const hit of docsHits) {
        parts.push(
          `- **${hit.symbol}**: ${hit.docs_files.join(", ")}`
        );
      }
    } else if (docsDir) {
      parts.push("No docs pages reference the changed symbols.");
    } else {
      parts.push(
        "Docs repo not cached. Run get_project_info('arkade-docs') first, then re-run to cross-reference."
      );
    }

    return { content: [{ type: "text", text: parts.join("\n") }] };
  }
);

// Tool: check_context_freshness
server.tool(
  "check_context_freshness",
  "Verify context docs and/or repo README files against live source. Checks that types, functions, and file paths referenced still exist in the actual repos. Flags stale references.",
  {
    context_doc: z
      .string()
      .optional()
      .describe(
        "Specific context doc to check (e.g. 'ts-sdk', 'vtxo-model'). Omit to check all."
      ),
    include_readmes: z
      .boolean()
      .optional()
      .describe("Also check README.md files in cached repos for stale code block references. Defaults to false."),
    projects: z
      .array(z.string())
      .optional()
      .describe("When include_readmes is true, limit to these project IDs. Omit to check all cached repos."),
  },
  async ({ context_doc, include_readmes, projects: readmeProjects }) => {
    const contextDir = join(ROOT, "context");
    if (!existsSync(contextDir)) {
      return { content: [{ type: "text", text: "No context/ directory found." }] };
    }

    const docs = context_doc
      ? [`${context_doc}.md`]
      : readdirSync(contextDir).filter((f) => f.endsWith(".md"));

    const report = [];

    for (const docFile of docs) {
      const docPath = join(contextDir, docFile);
      if (!existsSync(docPath)) {
        report.push(`## ${docFile}\nFile not found.`);
        continue;
      }

      const content = readFileSync(docPath, "utf-8");
      const docName = docFile.replace(".md", "");

      // Extract referenced file paths (patterns like `src/foo/bar.go`, `internal/core/domain/vtxo.go`)
      const pathRefs = [
        ...content.matchAll(/`([a-zA-Z][a-zA-Z0-9_\-./]*\.(go|ts|tsx|rs|toml|proto))`/g),
      ].map((m) => m[1]);

      // Extract referenced type/function names (patterns like `type Foo`, `func Bar`, `export interface Baz`)
      const symbolRefs = [
        ...content.matchAll(
          /(?:type|func|struct|interface|class|trait|enum|const)\s+(\w{4,})/g
        ),
      ].map((m) => m[1]);

      // Determine which repos to check based on doc name and content
      const repoHints = [];
      for (const [id, proj] of Object.entries(REGISTRY.projects)) {
        if (docName === id || content.includes(proj.repo) || content.includes(id)) {
          repoHints.push(id);
        }
      }

      const issues = [];
      const checked = { paths: 0, symbols: 0 };

      for (const projectId of repoHints) {
        if (!repoExists(projectId)) continue;
        const repoDir = join(CACHE_DIR, projectId);

        // Check file paths
        const uniquePaths = [...new Set(pathRefs)];
        for (const refPath of uniquePaths) {
          const fullPath = join(repoDir, refPath);
          if (!existsSync(fullPath)) {
            // Try common prefixes
            const prefixed = [refPath, `server/${refPath}`, `src/${refPath}`];
            const found = prefixed.some((p) => existsSync(join(repoDir, p)));
            if (!found) {
              issues.push(`Path not found: \`${refPath}\` (checked in ${projectId})`);
            }
          }
          checked.paths++;
        }

        // Spot-check symbols (grep a sample)
        const symbolSample = [...new Set(symbolRefs)].slice(0, 15);
        for (const symbol of symbolSample) {
          const result = searchInRepo(repoDir, symbol, null);
          if (result === "No matches found") {
            issues.push(`Symbol not found: \`${symbol}\` (checked in ${projectId})`);
          }
          checked.symbols++;
        }
      }

      if (repoHints.length === 0) {
        report.push(
          `## ${docFile}\nNo matching repos cached. Run get_project_info first for related projects.`
        );
      } else if (issues.length === 0) {
        report.push(
          `## ${docFile}\nAll references valid. Checked ${checked.paths} paths, ${checked.symbols} symbols in [${repoHints.join(", ")}].`
        );
      } else {
        report.push(
          `## ${docFile}\n${issues.length} stale reference(s) found (checked ${checked.paths} paths, ${checked.symbols} symbols in [${repoHints.join(", ")}]):\n${issues.map((i) => `- ${i}`).join("\n")}`
        );
      }
    }

    // --- README freshness check ---
    if (include_readmes) {
      const targetProjects = readmeProjects || Object.keys(REGISTRY.projects).filter(p => repoExists(p));

      for (const projectId of targetProjects) {
        if (!repoExists(projectId)) continue;
        let repoDir;
        try { repoDir = ensureRepo(projectId); } catch { continue; }
        const readmePath = join(repoDir, "README.md");
        if (!existsSync(readmePath)) {
          report.push(`## ${projectId}/README.md\nNo README.md found.`);
          continue;
        }

        const readmeContent = readFileSync(readmePath, "utf-8");
        if (readmeContent.length > 500000) {
          report.push(`## ${projectId}/README.md\nSkipped (file too large).`);
          continue;
        }

        const codeBlocks = extractCodeBlocks(readmeContent);
        const lang = REGISTRY.projects[projectId]?.language;
        const langBlocks = codeBlocks.filter(b => {
          const l = b.language;
          if (lang === "typescript") return ["ts", "typescript", "js", "javascript"].includes(l);
          if (lang === "go") return ["go", "golang"].includes(l);
          if (lang === "rust") return ["rust", "rs"].includes(l);
          if (lang === "csharp") return ["csharp", "cs", "c#"].includes(l);
          return false;
        });

        const readmeIssues = [];
        const readmeChecked = { blocks: langBlocks.length, symbols: 0 };

        for (const block of langBlocks.slice(0, 30)) {
          const symbols = extractImportsFromCodeBlock(block.code, block.language);
          for (const symbol of symbols) {
            const searchResult = searchInRepo(repoDir, symbol, null);
            if (searchResult === "No matches found") {
              readmeIssues.push(`Line ${block.line}, block #${block.index}: symbol \`${symbol}\` not found`);
            }
            readmeChecked.symbols++;
          }
        }

        // Also check file path references
        const readmePathRefs = [...readmeContent.matchAll(/`([a-zA-Z][a-zA-Z0-9_\-./]*\.(go|ts|tsx|rs|toml|proto|cs))`/g)].map(m => m[1]);
        for (const refPath of [...new Set(readmePathRefs)]) {
          if (!existsSync(join(repoDir, refPath))) {
            readmeIssues.push(`Path \`${refPath}\` not found`);
          }
          readmeChecked.symbols++;
        }

        if (readmeIssues.length === 0) {
          report.push(`## ${projectId}/README.md\nAll references valid. Checked ${readmeChecked.blocks} code blocks, ${readmeChecked.symbols} symbols/paths.`);
        } else {
          report.push(`## ${projectId}/README.md\n${readmeIssues.length} issue(s) (checked ${readmeChecked.blocks} blocks, ${readmeChecked.symbols} symbols/paths):\n${readmeIssues.map(i => `- ${i}`).join("\n")}`);
        }
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `# Context Freshness Report\n\n${report.join("\n\n")}`,
        },
      ],
    };
  }
);

// Tool: git_history
server.tool(
  "git_history",
  "Search git history for commits that added or removed a string. Automatically unshallows the clone if needed. Uses git log -S (pickaxe).",
  {
    project: z.string().describe("Project ID from registry"),
    search: z.string().describe("String to search for in diffs (finds commits that added or removed this string)"),
    path: z.string().optional().describe("Limit search to a specific file or directory path"),
    max_results: z.number().optional().describe("Max commits to return. Defaults to 20."),
  },
  async ({ project, search, path: filePath, max_results }) => {
    const proj = REGISTRY.projects[project];
    if (!proj) {
      const available = Object.keys(REGISTRY.projects).join(", ");
      return { content: [{ type: "text", text: `Unknown project: ${project}\nAvailable: ${available}` }] };
    }

    let repoDir;
    try {
      repoDir = ensureRepo(project);
    } catch (e) {
      return { content: [{ type: "text", text: `Failed to clone ${project}: ${e.message}` }] };
    }

    // Unshallow on demand
    try {
      ensureUnshallow(repoDir);
    } catch (e) {
      return { content: [{ type: "text", text: `Failed to unshallow ${project}: ${e.message}. Try again when online.` }] };
    }

    const count = max_results || 20;
    const pathFilter = filePath ? ` -- ${JSON.stringify(filePath)}` : "";
    const cmd = `git log --format="%h %ad %s" --date=short -S ${JSON.stringify(search)} -n ${count}${pathFilter}`;

    let logResult;
    try {
      logResult = execSync(cmd, { cwd: repoDir, encoding: "utf-8", timeout: 30000 }).trim();
    } catch (e) {
      return { content: [{ type: "text", text: `Git search failed: ${e.message}` }] };
    }

    if (!logResult) {
      return { content: [{ type: "text", text: `No commits found that added or removed "${search}" in ${project}.` }] };
    }

    const commits = logResult.split("\n");
    const parts = [`# Git History: ${project}\nSearch: "${search}"${filePath ? `\nPath: ${filePath}` : ""}\n${commits.length} commit(s) found\n`];

    // Get detail for first 5 commits
    const detailed = commits.slice(0, 5);
    for (const line of detailed) {
      const sha = line.split(" ")[0];
      try {
        const stat = execSync(
          `git show --stat --no-patch --format="%h %s%nAuthor: %an <%ae>%nDate: %ad" --date=short ${sha}`,
          { cwd: repoDir, encoding: "utf-8", timeout: 5000 }
        ).trim();
        parts.push(stat);
      } catch {
        parts.push(line);
      }
    }

    if (commits.length > 5) {
      parts.push(`\n... and ${commits.length - 5} more commit(s):\n${commits.slice(5).join("\n")}`);
    }

    return { content: [{ type: "text", text: parts.join("\n\n") }] };
  }
);

// Tool: tree
server.tool(
  "tree",
  "Get recursive directory tree of an Arkade repo. Excludes node_modules, .git, and build artifacts by default.",
  {
    project: z.string().describe("Project ID from registry"),
    path: z.string().optional().describe("Subdirectory to start from. Defaults to repo root."),
    depth: z.number().optional().describe("Max directory depth. Defaults to 4."),
    include: z.string().optional().describe("File extension filter, comma-separated (e.g. '.ts,.go'). Omit to show all files."),
  },
  async ({ project, path: subPath, depth, include }) => {
    const proj = REGISTRY.projects[project];
    if (!proj) {
      const available = Object.keys(REGISTRY.projects).join(", ");
      return { content: [{ type: "text", text: `Unknown project: ${project}\nAvailable: ${available}` }] };
    }

    let repoDir;
    try {
      repoDir = ensureRepo(project);
    } catch (e) {
      return { content: [{ type: "text", text: `Failed to clone ${project}: ${e.message}` }] };
    }

    const startPath = subPath || ".";
    const maxDepth = depth || 4;
    const includeExts = include ? include.split(",").map(s => s.trim()) : null;

    const fullStart = join(repoDir, startPath);
    if (!existsSync(fullStart)) {
      return { content: [{ type: "text", text: `Path not found: ${startPath}` }] };
    }

    const entries = buildTree(repoDir, startPath, maxDepth, includeExts);

    let dirCount = 0;
    let fileCount = 0;
    const lines = [];
    const cap = 500;

    for (const entry of entries) {
      if (lines.length >= cap) break;
      if (entry.type === "d") dirCount++;
      else fileCount++;

      if (entry.truncated) {
        lines.push("  ".repeat(entry.path.split("/").length - 1) + "... (depth limit)");
        continue;
      }

      const parts = entry.path.split("/").filter(Boolean);
      const indent = "  ".repeat(Math.max(0, parts.length - 1));
      const name = parts[parts.length - 1] || entry.path;
      lines.push(`${indent}${name}`);
    }

    const header = `# ${project} tree${subPath ? ` (${subPath})` : ""}\n${fileCount} files, ${dirCount} directories\n`;
    let body = lines.join("\n");
    if (entries.length > cap) {
      body += `\n\n... truncated (${entries.length - cap} more entries)`;
    }

    return { content: [{ type: "text", text: header + body }] };
  }
);

// Tool: check_readme
server.tool(
  "check_readme",
  "Validate code blocks in a repo's README or markdown file. Extracts imports and function calls, cross-references against the repo's actual source. Catches stale documentation.",
  {
    project: z.string().describe("Project ID from registry"),
    file: z.string().optional().describe("Markdown file path relative to repo root. Defaults to README.md."),
  },
  async ({ project, file }) => {
    const proj = REGISTRY.projects[project];
    if (!proj) {
      const available = Object.keys(REGISTRY.projects).join(", ");
      return { content: [{ type: "text", text: `Unknown project: ${project}\nAvailable: ${available}` }] };
    }

    let repoDir;
    try {
      repoDir = ensureRepo(project);
    } catch (e) {
      return { content: [{ type: "text", text: `Failed to clone ${project}: ${e.message}` }] };
    }

    const targetFile = file || "README.md";
    const readmePath = join(repoDir, targetFile);
    if (!existsSync(readmePath)) {
      return { content: [{ type: "text", text: `File not found: ${targetFile}` }] };
    }

    const content = readFileSync(readmePath, "utf-8");
    const codeBlocks = extractCodeBlocks(content);

    if (codeBlocks.length === 0) {
      return { content: [{ type: "text", text: `No fenced code blocks found in ${targetFile}.` }] };
    }

    // Filter to language-relevant blocks
    const langMap = {
      typescript: ["ts", "typescript", "js", "javascript", "tsx", "jsx"],
      go: ["go", "golang"],
      rust: ["rust", "rs"],
      csharp: ["csharp", "cs", "c#"],
    };
    const validLangs = langMap[proj.language] || [];
    const relevantBlocks = codeBlocks.filter(b => validLangs.includes(b.language));

    const issues = [];
    const stats = { blocks: relevantBlocks.length, symbols: 0, skipped: 0 };

    if (codeBlocks.length > 30) {
      stats.skipped = codeBlocks.length - 30;
    }

    for (const block of relevantBlocks.slice(0, 30)) {
      const symbols = extractImportsFromCodeBlock(block.code, block.language);
      for (const symbol of symbols) {
        const result = searchInRepo(repoDir, symbol, null);
        if (result === "No matches found") {
          issues.push({ symbol, line: block.line, block: block.index });
        }
        stats.symbols++;
      }
    }

    // Also check file path references
    const pathRefs = [...content.matchAll(/`([a-zA-Z][a-zA-Z0-9_\-./]*\.(go|ts|tsx|rs|cs|toml|proto))`/g)].map(m => m[1]);
    for (const refPath of [...new Set(pathRefs)]) {
      if (!existsSync(join(repoDir, refPath))) {
        issues.push({ symbol: refPath, line: 0, block: 0, isPath: true });
      }
      stats.symbols++;
    }

    // Format report
    const parts = [
      `# README Check: ${project}/${targetFile}`,
      `Analyzed ${stats.blocks} code blocks, checked ${stats.symbols} symbols/paths`,
      stats.skipped > 0 ? `(${stats.skipped} blocks skipped due to cap)` : "",
    ].filter(Boolean);

    if (issues.length === 0) {
      parts.push("\nAll symbols and paths validated successfully.");
    } else {
      parts.push(`\n${issues.length} issue(s) found:\n`);
      for (const issue of issues) {
        if (issue.isPath) {
          parts.push(`- Path \`${issue.symbol}\` not found in repo`);
        } else {
          parts.push(`- \`${issue.symbol}\` not found (line ${issue.line}, block #${issue.block})`);
        }
      }
    }

    return { content: [{ type: "text", text: parts.join("\n") }] };
  }
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
