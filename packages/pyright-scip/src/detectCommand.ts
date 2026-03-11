import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import { parse as parseToml } from '@iarna/toml';
import { glob } from 'glob';
import { DetectOptions } from './MainCommand';

interface ProjectConfig {
    configFile: string;
    type: string;
}

export interface ProjectNode {
    name: string;
    path: string;
    language: string;
    buildTool: string;
    config?: ProjectConfig;
    dependencies?: string[];
    subProjects?: ProjectNode[];
}

export interface DetectOutput {
    projects: ProjectNode[];
}

const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    '__pycache__',
    '.venv',
    'venv',
    '.tox',
    '.eggs',
    'dist',
    'build',
    '.mypy_cache',
    '.pytest_cache',
    '.ruff_cache',
    'tests',
    'test',
    'testing',
    '__tests__',
    'fixtures',
]);

function shouldSkipDir(dirName: string): boolean {
    if (SKIP_DIRS.has(dirName)) {
        return true;
    }
    if (dirName.endsWith('.egg-info')) {
        return true;
    }
    return false;
}

function findProjectMarkers(rootDir: string): string[] {
    const markers: string[] = [];

    function walk(dir: string): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!shouldSkipDir(entry.name)) {
                    walk(path.join(dir, entry.name));
                }
            } else if (entry.isFile()) {
                if (
                    entry.name === 'pyproject.toml' ||
                    entry.name === 'setup.py' ||
                    entry.name === 'setup.cfg'
                ) {
                    markers.push(path.join(dir, entry.name));
                }
            }
        }
    }

    walk(rootDir);
    return markers;
}

function readToml(filePath: string): Record<string, any> {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return parseToml(content) as Record<string, any>;
    } catch {
        return {};
    }
}

function readSetupCfg(filePath: string): string | undefined {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        let inMetadata = false;
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === '[metadata]') {
                inMetadata = true;
                continue;
            }
            if (trimmed.startsWith('[') && inMetadata) {
                break;
            }
            if (inMetadata) {
                const match = trimmed.match(/^name\s*=\s*(.+)$/);
                if (match) {
                    return match[1].trim();
                }
            }
        }
    } catch {
        return undefined;
    }
    return undefined;
}

function detectBuildTool(tomlData: Record<string, any>, projectDir: string): string {
    const buildSystem = tomlData['build-system'] as Record<string, any> | undefined;
    const buildBackend = buildSystem?.['build-backend'] as string | undefined;

    const hasUvLock =
        fs.existsSync(path.join(projectDir, 'uv.lock')) ||
        fs.existsSync(path.join(path.dirname(projectDir), 'uv.lock'));
    const hasTool = tomlData['tool'] !== undefined;
    const hasUvTool = hasTool && (tomlData['tool'] as Record<string, any>)['uv'] !== undefined;

    if (hasUvLock && hasUvTool) {
        return 'uv';
    }

    if (buildBackend) {
        if (buildBackend.includes('hatchling')) return 'hatchling';
        if (buildBackend.includes('poetry')) return 'poetry';
        if (buildBackend.includes('flit')) return 'flit';
        if (buildBackend.includes('maturin')) return 'maturin';
        if (buildBackend.includes('setuptools')) return 'setuptools';
    }

    const tool = tomlData['tool'] as Record<string, any> | undefined;
    if (tool?.['poetry']) return 'poetry';
    if (hasUvTool) return 'uv';

    return 'pip';
}

function extractDependencyNames(deps: any[]): string[] {
    if (!Array.isArray(deps)) return [];
    return deps
        .filter((d) => typeof d === 'string')
        .map((d) => {
            const match = d.match(/^([A-Za-z0-9_.-]+)/);
            return match ? match[1].toLowerCase().replace(/_/g, '-') : d.toLowerCase();
        });
}

interface ParsedProject {
    absDir: string;
    configFile: string;
    name: string;
    buildTool: string;
    rawDependencies: string[];
    isUvWorkspaceRoot: boolean;
    uvWorkspaceMembers: string[];
}

function parsePyprojectToml(tomlPath: string): ParsedProject | undefined {
    const projectDir = path.dirname(tomlPath);
    const tomlData = readToml(tomlPath);

    const project = tomlData['project'] as Record<string, any> | undefined;
    const tool = tomlData['tool'] as Record<string, any> | undefined;
    const poetry = tool?.['poetry'] as Record<string, any> | undefined;
    const uv = tool?.['uv'] as Record<string, any> | undefined;

    const hasBuildSystem = tomlData['build-system'] !== undefined;
    if (!project && !poetry && !hasBuildSystem) {
        return undefined;
    }

    const name =
        (project?.['name'] as string | undefined) ||
        (poetry?.['name'] as string | undefined) ||
        path.basename(projectDir);

    const buildTool = detectBuildTool(tomlData, projectDir);

    const rawDeps = project?.['dependencies'] ?? poetry?.['dependencies'] ?? [];
    const rawDependencies = extractDependencyNames(
        Array.isArray(rawDeps) ? rawDeps : Object.keys(rawDeps as Record<string, any>)
    );

    const uvWorkspace = uv?.['workspace'] as Record<string, any> | undefined;
    const isUvWorkspaceRoot = uvWorkspace !== undefined && Array.isArray(uvWorkspace['members']);
    const uvWorkspaceMembers = isUvWorkspaceRoot
        ? (uvWorkspace!['members'] as string[])
        : [];

    return {
        absDir: projectDir,
        configFile: 'pyproject.toml',
        name: name.toLowerCase().replace(/_/g, '-'),
        buildTool,
        rawDependencies,
        isUvWorkspaceRoot,
        uvWorkspaceMembers,
    };
}

function isSetupPyPackageScript(filePath: string): boolean {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return (
            content.includes('from setuptools import') ||
            content.includes('from setuptools.') ||
            content.includes('import setuptools') ||
            content.includes('from distutils') ||
            content.includes('import distutils')
        );
    } catch {
        return false;
    }
}

function parseSetupFiles(markers: string[], existingDirs: Set<string>): ParsedProject[] {
    const results: ParsedProject[] = [];
    const setupPyDirs = new Set<string>();
    const setupCfgDirs = new Set<string>();

    for (const marker of markers) {
        const dir = path.dirname(marker);
        const base = path.basename(marker);
        if (base === 'setup.py' && isSetupPyPackageScript(marker)) setupPyDirs.add(dir);
        if (base === 'setup.cfg') setupCfgDirs.add(dir);
    }

    const setupDirs = new Set([...setupPyDirs, ...setupCfgDirs]);
    for (const dir of setupDirs) {
        if (existingDirs.has(dir)) continue;

        let name = path.basename(dir);
        let configFile = 'setup.py';

        if (setupCfgDirs.has(dir)) {
            const cfgName = readSetupCfg(path.join(dir, 'setup.cfg'));
            if (cfgName) name = cfgName;
            configFile = 'setup.cfg';
        }

        results.push({
            absDir: dir,
            configFile,
            name: name.toLowerCase().replace(/_/g, '-'),
            buildTool: 'setuptools',
            rawDependencies: [],
            isUvWorkspaceRoot: false,
            uvWorkspaceMembers: [],
        });
    }

    return results;
}

function resolveUvWorkspaceMembers(workspaceDir: string, memberGlobs: string[]): string[] {
    const resolved: string[] = [];
    for (const pattern of memberGlobs) {
        const matches = glob.sync(pattern, { cwd: workspaceDir, absolute: false });
        for (const match of matches) {
            const absMatch = path.join(workspaceDir, match);
            if (
                fs.existsSync(path.join(absMatch, 'pyproject.toml')) ||
                fs.existsSync(path.join(absMatch, 'setup.py')) ||
                fs.existsSync(path.join(absMatch, 'setup.cfg'))
            ) {
                resolved.push(absMatch);
            }
        }
    }
    return resolved;
}

function normalizeName(name: string): string {
    return name.toLowerCase().replace(/[_.-]+/g, '-');
}

function buildProjectNode(
    parsed: ParsedProject,
    repoRoot: string,
    allParsedByDir: Map<string, ParsedProject>,
    allNameSet: Set<string>,
    subProjectDirs: Set<string>
): ProjectNode {
    const relPath = path.relative(repoRoot, parsed.absDir) || '.';

    const internalDeps = parsed.rawDependencies
        .map((d) => normalizeName(d))
        .filter((d) => allNameSet.has(d));

    let subProjects: ProjectNode[] | undefined;

    if (parsed.isUvWorkspaceRoot) {
        const memberAbsDirs = resolveUvWorkspaceMembers(parsed.absDir, parsed.uvWorkspaceMembers);
        const memberNodes: ProjectNode[] = [];
        for (const memberDir of memberAbsDirs) {
            const memberParsed = allParsedByDir.get(memberDir);
            if (memberParsed && memberDir !== parsed.absDir) {
                subProjectDirs.add(memberDir);
                memberNodes.push(buildProjectNode(memberParsed, repoRoot, allParsedByDir, allNameSet, subProjectDirs));
            }
        }
        if (memberNodes.length > 0) {
            subProjects = memberNodes;
        }
    }

    const node: ProjectNode = {
        name: parsed.name,
        path: relPath,
        language: 'python',
        buildTool: parsed.buildTool,
        config: { configFile: parsed.configFile, type: 'python' },
    };

    if (internalDeps.length > 0) {
        node.dependencies = internalDeps;
    }

    if (subProjects && subProjects.length > 0) {
        node.subProjects = subProjects;
    }

    return node;
}

function isDescendant(potentialChild: string, potentialParent: string): boolean {
    const rel = path.relative(potentialParent, potentialChild);
    return !rel.startsWith('..') && rel !== '';
}

function buildNonWorkspaceTree(
    parsedProjects: ParsedProject[],
    repoRoot: string,
    allNameSet: Set<string>,
    allParsedByDir: Map<string, ParsedProject>
): ProjectNode[] {
    const subProjectDirs = new Set<string>();

    const sortedByDepth = [...parsedProjects].sort((a, b) => {
        const depthA = path.relative(repoRoot, a.absDir).split(path.sep).length;
        const depthB = path.relative(repoRoot, b.absDir).split(path.sep).length;
        return depthA - depthB;
    });

    const parentMap = new Map<string, string>();
    for (let i = 0; i < sortedByDepth.length; i++) {
        for (let j = 0; j < i; j++) {
            if (isDescendant(sortedByDepth[i].absDir, sortedByDepth[j].absDir)) {
                if (!parentMap.has(sortedByDepth[i].absDir)) {
                    parentMap.set(sortedByDepth[i].absDir, sortedByDepth[j].absDir);
                }
            }
        }
    }

    const childrenMap = new Map<string, ParsedProject[]>();
    for (const [childDir, parentDir] of parentMap.entries()) {
        const child = allParsedByDir.get(childDir)!;
        if (!childrenMap.has(parentDir)) {
            childrenMap.set(parentDir, []);
        }
        childrenMap.get(parentDir)!.push(child);
        subProjectDirs.add(childDir);
    }

    function buildNode(parsed: ParsedProject): ProjectNode {
        const relPath = path.relative(repoRoot, parsed.absDir) || '.';
        const internalDeps = parsed.rawDependencies
            .map((d) => normalizeName(d))
            .filter((d) => allNameSet.has(d));

        const children = childrenMap.get(parsed.absDir) ?? [];
        const childNodes = children.map((c) => buildNode(c));

        const node: ProjectNode = {
            name: parsed.name,
            path: relPath,
            language: 'python',
            buildTool: parsed.buildTool,
            config: { configFile: parsed.configFile, type: 'python' },
        };

        if (internalDeps.length > 0) {
            node.dependencies = internalDeps;
        }

        if (childNodes.length > 0) {
            node.subProjects = childNodes;
        }

        return node;
    }

    const topLevel = sortedByDepth.filter((p) => !subProjectDirs.has(p.absDir));
    return topLevel.map((p) => buildNode(p));
}

const PYTHON_AST_SCRIPT = `
import ast, os, json, sys

def get_imports(filepath):
    try:
        with open(filepath) as f:
            tree = ast.parse(f.read())
    except:
        return set()
    imports = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.add(alias.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.level == 0:
                imports.add(node.module.split('.')[0])
    return imports

src_dir = sys.argv[1]
siblings = set(sys.argv[2:])
all_imports = set()
for root, dirs, files in os.walk(src_dir):
    dirs[:] = [d for d in dirs if d not in {'tests', 'test', 'testing', '__tests__', 'fixtures', '__pycache__', '.git', 'node_modules', '.venv', 'venv'}]
    for f in files:
        if not f.endswith('.py'):
            continue
        if f.startswith('test_') or f.endswith('_test.py') or f == 'conftest.py':
            continue
        all_imports.update(get_imports(os.path.join(root, f)))
print(json.dumps(sorted(all_imports.intersection(siblings))))
`.trim();

function resolveImportedSiblings(projectDir: string, siblingNames: string[]): string[] {
    const normalizedToOriginal = new Map<string, string>();
    for (const name of siblingNames) {
        normalizedToOriginal.set(name.replace(/-/g, '_'), name);
    }
    const normalizedSiblings = Array.from(normalizedToOriginal.keys());

    let result: childProcess.SpawnSyncReturns<Buffer>;
    try {
        result = childProcess.spawnSync(
            'python3',
            ['-c', PYTHON_AST_SCRIPT, projectDir, ...normalizedSiblings],
            { encoding: 'buffer', timeout: 30000 }
        );
    } catch {
        return [];
    }

    if (result.status !== 0 || !result.stdout) {
        return [];
    }

    let parsed: string[];
    try {
        parsed = JSON.parse(result.stdout.toString('utf-8').trim());
    } catch {
        return [];
    }

    return parsed
        .map((importedNormalized) => normalizedToOriginal.get(importedNormalized))
        .filter((name): name is string => name !== undefined);
}

function resolveUvMemberSiblingDeps(node: ProjectNode, siblingNames: string[], projectAbsDir: string): void {
    const existingDeps = new Set(node.dependencies ?? []);
    const undeclaredSiblings = siblingNames.filter(
        (s) => s !== node.name && !existingDeps.has(s)
    );

    if (undeclaredSiblings.length === 0) {
        return;
    }

    const discovered = resolveImportedSiblings(projectAbsDir, undeclaredSiblings);
    if (discovered.length === 0) {
        return;
    }

    const merged = Array.from(new Set([...existingDeps, ...discovered])).sort();
    node.dependencies = merged;
}

function postProcessUvWorkspaceNodes(workspaceNode: ProjectNode, allParsedByDir: Map<string, ParsedProject>, repoRoot: string): void {
    const subProjects = workspaceNode.subProjects;
    if (!subProjects || subProjects.length === 0) {
        return;
    }

    const allWorkspaceNames = [workspaceNode.name, ...subProjects.map((s) => s.name)];

    for (const member of subProjects) {
        const memberAbsDir = path.resolve(repoRoot, member.path);
        const memberParsed = allParsedByDir.get(memberAbsDir);
        if (!memberParsed) {
            continue;
        }

        const siblingNames = allWorkspaceNames.filter((n) => n !== member.name);
        const declaredSiblingDeps = (member.dependencies ?? []).filter((d) => siblingNames.includes(d));
        if (declaredSiblingDeps.length === siblingNames.length) {
            continue;
        }

        resolveUvMemberSiblingDeps(member, siblingNames, memberParsed.absDir);
    }
}

export function detect(cwd: string): DetectOutput {
    const repoRoot = path.resolve(cwd);

    const allMarkers = findProjectMarkers(repoRoot);

    const pyprojectPaths = allMarkers.filter((m) => path.basename(m) === 'pyproject.toml');
    const otherMarkers = allMarkers.filter((m) => path.basename(m) !== 'pyproject.toml');

    const parsedPyprojects: ParsedProject[] = [];
    const pyprojectDirs = new Set<string>();

    for (const tomlPath of pyprojectPaths) {
        const parsed = parsePyprojectToml(tomlPath);
        if (parsed) {
            parsedPyprojects.push(parsed);
            pyprojectDirs.add(parsed.absDir);
        }
    }

    const parsedSetupFiles = parseSetupFiles(otherMarkers, pyprojectDirs);
    const allParsed = [...parsedPyprojects, ...parsedSetupFiles];

    if (allParsed.length === 0) {
        return { projects: [] };
    }

    const allParsedByDir = new Map<string, ParsedProject>();
    for (const p of allParsed) {
        allParsedByDir.set(p.absDir, p);
    }

    const allNameSet = new Set(allParsed.map((p) => normalizeName(p.name)));

    const hasWorkspaceRoot = allParsed.some((p) => p.isUvWorkspaceRoot);

    let topLevelNodes: ProjectNode[];

    if (hasWorkspaceRoot) {
        const subProjectDirs = new Set<string>();
        const workspaceRoots = allParsed.filter((p) => p.isUvWorkspaceRoot);

        for (const root of workspaceRoots) {
            const memberDirs = resolveUvWorkspaceMembers(root.absDir, root.uvWorkspaceMembers);
            for (const memberDir of memberDirs) {
                if (memberDir !== root.absDir) {
                    subProjectDirs.add(memberDir);
                }
            }
        }

        const nonWorkspaceTopLevel = allParsed.filter(
            (p) => !p.isUvWorkspaceRoot && !subProjectDirs.has(p.absDir)
        );

        const workspaceNodes = workspaceRoots.map((root) => {
            const memberDirs = resolveUvWorkspaceMembers(root.absDir, root.uvWorkspaceMembers);
            const memberNodes: ProjectNode[] = [];
            for (const memberDir of memberDirs) {
                const memberParsed = allParsedByDir.get(memberDir);
                if (memberParsed && memberDir !== root.absDir) {
                    memberNodes.push(buildProjectNode(memberParsed, repoRoot, allParsedByDir, allNameSet, new Set()));
                }
            }

            const relPath = path.relative(repoRoot, root.absDir) || '.';
            const internalDeps = root.rawDependencies
                .map((d) => normalizeName(d))
                .filter((d) => allNameSet.has(d));

            const node: ProjectNode = {
                name: root.name,
                path: relPath,
                language: 'python',
                buildTool: root.buildTool,
                config: { configFile: root.configFile, type: 'python' },
            };

            if (internalDeps.length > 0) {
                node.dependencies = internalDeps;
            }

            if (memberNodes.length > 0) {
                node.subProjects = memberNodes;
            }

            return node;
        });

        const nonWorkspaceNodes = buildNonWorkspaceTree(
            nonWorkspaceTopLevel,
            repoRoot,
            allNameSet,
            allParsedByDir
        );

        topLevelNodes = [...workspaceNodes, ...nonWorkspaceNodes];
    } else {
        topLevelNodes = buildNonWorkspaceTree(allParsed, repoRoot, allNameSet, allParsedByDir);
    }

    if (hasWorkspaceRoot) {
        for (const node of topLevelNodes) {
            if (node.subProjects && node.subProjects.length > 0) {
                postProcessUvWorkspaceNodes(node, allParsedByDir, repoRoot);
            }
        }
    }

    return { projects: topLevelNodes };
}

export function detectAction(options: DetectOptions): void {
    const output = detect(options.cwd);
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}
