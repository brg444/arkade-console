#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const REGISTRY = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf-8"));
const CACHE_DIR = join(ROOT, ".repo-cache");

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
      }
    } else {
      // Directory: extract from all source files
      const files = readdirSync(fullPath).filter(
        (f) => f.endsWith(".ts") || f.endsWith(".go")
      );
      const parts = files.slice(0, 10).map((f) => {
        const fp = join(entryPath, f);
        if (f.endsWith(".ts")) return extractTypeScriptExports(repoDir, fp);
        if (f.endsWith(".go")) return extractGoInterfaces(repoDir, fp);
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
      } else {
        result = readFileSync(fullPath, "utf-8").slice(0, 10000);
      }
    } else if (existsSync(fullPath)) {
      // It's a directory: list contents and extract from key files
      const listing = readDirectory(repoDir, entryPath);
      const files = readdirSync(fullPath).filter(
        (f) => f.endsWith(".ts") || f.endsWith(".go")
      );

      const extractions = files.slice(0, 8).map((f) => {
        const fp = join(entryPath, f);
        if (proj.language === "typescript" || f.endsWith(".ts")) {
          return `// --- ${f} ---\n${extractTypeScriptExports(repoDir, fp)}`;
        } else if (proj.language === "go" || f.endsWith(".go")) {
          return `// --- ${f} ---\n${extractGoInterfaces(repoDir, fp)}`;
        }
        return "";
      });

      result = `Directory: ${entryPath}\n${listing}\n\n${extractions.filter(Boolean).join("\n\n")}`;
    } else {
      result = `Path not found: ${entryPath}`;
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
      return {
        content: [{ type: "text", text: `File not found: ${filePath}` }],
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

    const repoDir = join(CACHE_DIR, project);
    if (!repoExists(project)) {
      return {
        content: [
          {
            type: "text",
            text: "No cached version to compare against. Run get_api_surface first, then check again after the repo updates.",
          },
        ],
      };
    }

    // Snapshot before pull
    const before = snapshotApiSurface(repoDir, project);
    const oldTag = getLatestTag(repoDir);

    // Pull latest
    ensureRepo(project);
    const newTag = getLatestTag(repoDir);

    // Snapshot after pull
    const after = snapshotApiSurface(repoDir, project);

    // Diff
    const changes = diffSnapshots(before, after);

    if (changes.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No API surface changes detected in ${project} (${oldTag} -> ${newTag}).`,
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
      `Version: ${oldTag} -> ${newTag}`,
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
  "Verify context docs against live source. Checks that types, functions, and file paths referenced in context/ docs still exist in the actual repos. Flags stale references.",
  {
    context_doc: z
      .string()
      .optional()
      .describe(
        "Specific context doc to check (e.g. 'ts-sdk', 'vtxo-model'). Omit to check all."
      ),
  },
  async ({ context_doc }) => {
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

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
