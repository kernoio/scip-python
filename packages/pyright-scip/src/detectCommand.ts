import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import { parse as parseToml } from 'toml';
import { glob } from 'glob';
import { DetectOptions } from './MainCommand';

interface ProjectConfig {
    configFile: string;
    type: string;
}

export interface FlatProjectNode {
    name: string;
    path: string;
    parent: string | null;
    children: string[];
    producesArtifacts: boolean;
    languages: string[];
    buildTool: string;
    buildFiles: string[];
    dependencies: string[];
    config: ProjectConfig;
    imports?: Record<string, Record<string, Record<string, number>>>;
}

export interface Workspace {
    root: string;
    type: string;
    projects: FlatProjectNode[];
}

export interface DetectOutput {
    tool: string;
    workspaces: Workspace[];
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
                    entry.name === 'setup.cfg' ||
                    entry.name === 'requirements.txt' ||
                    entry.name === 'Pipfile'
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
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[scip-python detect] failed to parse TOML at ${filePath}: ${message}`);
        throw e;
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

    if (fs.existsSync(path.join(projectDir, 'poetry.lock'))) return 'poetry';

    if (fs.existsSync(path.join(projectDir, 'Pipfile'))) return 'pipenv';

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
    buildFiles: string[];
    rawDependencies: string[];
    isUvWorkspaceRoot: boolean;
    uvWorkspaceMembers: string[];
    hasProjectSection: boolean;
    hasPoetrySection: boolean;
}

function parsePyprojectToml(tomlPath: string): ParsedProject | undefined {
    const projectDir = path.dirname(tomlPath);
    const tomlData = readToml(tomlPath);

    const project = tomlData['project'] as Record<string, any> | undefined;
    const tool = tomlData['tool'] as Record<string, any> | undefined;
    const poetry = tool?.['poetry'] as Record<string, any> | undefined;
    const uv = tool?.['uv'] as Record<string, any> | undefined;

    const uvWorkspace = uv?.['workspace'] as Record<string, any> | undefined;
    const hasBuildSystem = tomlData['build-system'] !== undefined;
    if (!project && !poetry && !hasBuildSystem && !uvWorkspace) {
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

    const isUvWorkspaceRoot = uvWorkspace !== undefined && Array.isArray(uvWorkspace['members']);
    const uvWorkspaceMembers = isUvWorkspaceRoot
        ? (uvWorkspace!['members'] as string[])
        : [];

    const buildFiles: string[] = ['pyproject.toml'];
    if (fs.existsSync(path.join(projectDir, 'setup.py')) && isSetupPyPackageScript(path.join(projectDir, 'setup.py'))) {
        buildFiles.push('setup.py');
    }
    if (fs.existsSync(path.join(projectDir, 'setup.cfg'))) {
        buildFiles.push('setup.cfg');
    }
    if (buildTool === 'poetry' && fs.existsSync(path.join(projectDir, 'poetry.lock'))) {
        buildFiles.push('poetry.lock');
    }
    if (buildTool === 'uv' && fs.existsSync(path.join(projectDir, 'uv.lock'))) {
        buildFiles.push('uv.lock');
    }
    if (buildTool === 'pipenv' && fs.existsSync(path.join(projectDir, 'Pipfile.lock'))) {
        buildFiles.push('Pipfile.lock');
    }

    return {
        absDir: projectDir,
        configFile: 'pyproject.toml',
        name: name.toLowerCase().replace(/_/g, '-'),
        buildTool,
        buildFiles,
        rawDependencies,
        isUvWorkspaceRoot,
        uvWorkspaceMembers,
        hasProjectSection: project !== undefined,
        hasPoetrySection: poetry !== undefined,
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

        const setupBuildFiles: string[] = [];
        if (setupPyDirs.has(dir)) setupBuildFiles.push('setup.py');
        if (setupCfgDirs.has(dir)) setupBuildFiles.push('setup.cfg');
        if (fs.existsSync(path.join(dir, 'requirements.txt'))) setupBuildFiles.push('requirements.txt');

        results.push({
            absDir: dir,
            configFile,
            name: name.toLowerCase().replace(/_/g, '-'),
            buildTool: 'setuptools',
            buildFiles: setupBuildFiles,
            rawDependencies: [],
            isUvWorkspaceRoot: false,
            uvWorkspaceMembers: [],
            hasProjectSection: false,
            hasPoetrySection: false,
        });
    }

    return results;
}

function parseRequirementsTxt(markers: string[], existingDirs: Set<string>): ParsedProject[] {
    const results: ParsedProject[] = [];
    for (const marker of markers) {
        if (path.basename(marker) !== 'requirements.txt') continue;
        const dir = path.dirname(marker);
        if (existingDirs.has(dir)) continue;
        results.push({
            absDir: dir,
            configFile: 'requirements.txt',
            name: path.basename(dir).toLowerCase().replace(/_/g, '-'),
            buildTool: 'pip',
            buildFiles: ['requirements.txt'],
            rawDependencies: [],
            isUvWorkspaceRoot: false,
            uvWorkspaceMembers: [],
            hasProjectSection: false,
            hasPoetrySection: false,
        });
    }
    return results;
}

function parsePipfile(markers: string[], existingDirs: Set<string>): ParsedProject[] {
    const results: ParsedProject[] = [];
    for (const marker of markers) {
        if (path.basename(marker) !== 'Pipfile') continue;
        const dir = path.dirname(marker);
        if (existingDirs.has(dir)) continue;
        const buildFiles: string[] = ['Pipfile'];
        if (fs.existsSync(path.join(dir, 'Pipfile.lock'))) buildFiles.push('Pipfile.lock');
        results.push({
            absDir: dir,
            configFile: 'Pipfile',
            name: path.basename(dir).toLowerCase().replace(/_/g, '-'),
            buildTool: 'pipenv',
            buildFiles,
            rawDependencies: [],
            isUvWorkspaceRoot: false,
            uvWorkspaceMembers: [],
            hasProjectSection: false,
            hasPoetrySection: false,
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

function deriveWorkspaceType(rootParsed: ParsedProject, hasChildren: boolean): string {
    if (rootParsed.isUvWorkspaceRoot) {
        return 'uv';
    }
    if (rootParsed.hasPoetrySection && hasChildren) {
        return 'poetry';
    }
    return 'standalone';
}

function producesArtifacts(parsed: ParsedProject): boolean {
    return !parsed.isUvWorkspaceRoot;
}

function isDescendant(potentialChild: string, potentialParent: string): boolean {
    const rel = path.relative(potentialParent, potentialChild);
    return !rel.startsWith('..') && rel !== '';
}

interface TreeNode {
    parsed: ParsedProject;
    children: TreeNode[];
    parentAbsDir: string | null;
}

function buildForest(
    parsedProjects: ParsedProject[],
    repoRoot: string
): TreeNode[] {
    const sortedByDepth = [...parsedProjects].sort((a, b) => {
        const depthA = path.relative(repoRoot, a.absDir).split(path.sep).length;
        const depthB = path.relative(repoRoot, b.absDir).split(path.sep).length;
        return depthA - depthB;
    });

    const nodeMap = new Map<string, TreeNode>();
    for (const parsed of sortedByDepth) {
        nodeMap.set(parsed.absDir, { parsed, children: [], parentAbsDir: null });
    }

    for (let i = 0; i < sortedByDepth.length; i++) {
        const candidate = sortedByDepth[i];
        for (let j = 0; j < i; j++) {
            const potentialParent = sortedByDepth[j];
            if (isDescendant(candidate.absDir, potentialParent.absDir)) {
                const candidateNode = nodeMap.get(candidate.absDir)!;
                if (candidateNode.parentAbsDir === null) {
                    candidateNode.parentAbsDir = potentialParent.absDir;
                    nodeMap.get(potentialParent.absDir)!.children.push(candidateNode);
                }
            }
        }
    }

    return sortedByDepth
        .filter((p) => nodeMap.get(p.absDir)!.parentAbsDir === null)
        .map((p) => nodeMap.get(p.absDir)!);
}

function flattenTreeNode(
    treeNode: TreeNode,
    parentRelPath: string | null,
    repoRoot: string,
    allNameSet: Set<string>
): FlatProjectNode[] {
    const relPath = path.relative(repoRoot, treeNode.parsed.absDir) || '.';
    const childRelPaths = treeNode.children.map(
        (c) => path.relative(repoRoot, c.parsed.absDir) || '.'
    );

    const internalDeps = treeNode.parsed.rawDependencies
        .map((d) => normalizeName(d))
        .filter((d) => allNameSet.has(d));

    const node: FlatProjectNode = {
        name: treeNode.parsed.name,
        path: relPath,
        parent: parentRelPath,
        children: childRelPaths,
        producesArtifacts: producesArtifacts(treeNode.parsed),
        languages: ['python'],
        buildTool: treeNode.parsed.buildTool,
        buildFiles: treeNode.parsed.buildFiles,
        dependencies: internalDeps,
        config: { configFile: treeNode.parsed.configFile, type: 'python' },
    };

    const descendantNodes: FlatProjectNode[] = [];
    for (const child of treeNode.children) {
        descendantNodes.push(...flattenTreeNode(child, relPath, repoRoot, allNameSet));
    }

    return [node, ...descendantNodes];
}

function buildUvWorkspace(
    rootParsed: ParsedProject,
    allParsedByDir: Map<string, ParsedProject>,
    repoRoot: string,
    allNameSet: Set<string>
): Workspace {
    const rootRelPath = path.relative(repoRoot, rootParsed.absDir) || '.';
    const memberAbsDirs = resolveUvWorkspaceMembers(rootParsed.absDir, rootParsed.uvWorkspaceMembers);
    const memberAbsDirsFiltered = memberAbsDirs.filter((d) => d !== rootParsed.absDir);

    const childRelPaths = memberAbsDirsFiltered.map(
        (d) => path.relative(repoRoot, d) || '.'
    );

    const rootInternalDeps = rootParsed.rawDependencies
        .map((d) => normalizeName(d))
        .filter((d) => allNameSet.has(d));

    const rootNode: FlatProjectNode = {
        name: rootParsed.name,
        path: rootRelPath,
        parent: null,
        children: childRelPaths,
        producesArtifacts: producesArtifacts(rootParsed),
        languages: ['python'],
        buildTool: rootParsed.buildTool,
        buildFiles: rootParsed.buildFiles,
        dependencies: rootInternalDeps,
        config: { configFile: rootParsed.configFile, type: 'python' },
    };

    const memberNodes: FlatProjectNode[] = [];
    for (const memberDir of memberAbsDirsFiltered) {
        const memberParsed = allParsedByDir.get(memberDir);
        if (!memberParsed) continue;

        const memberRelPath = path.relative(repoRoot, memberDir) || '.';
        const memberInternalDeps = memberParsed.rawDependencies
            .map((d) => normalizeName(d))
            .filter((d) => allNameSet.has(d));

        memberNodes.push({
            name: memberParsed.name,
            path: memberRelPath,
            parent: rootRelPath,
            children: [],
            producesArtifacts: producesArtifacts(memberParsed),
            languages: ['python'],
            buildTool: memberParsed.buildTool,
            buildFiles: memberParsed.buildFiles,
            dependencies: memberInternalDeps,
            config: { configFile: memberParsed.configFile, type: 'python' },
        });
    }

    const projects = [rootNode, ...memberNodes];

    return {
        root: rootRelPath,
        type: deriveWorkspaceType(rootParsed, memberAbsDirsFiltered.length > 0),
        projects,
    };
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

const PYTHON_HEATMAP_SCRIPT = `
import ast, os, json, sys

def get_imports(filepath):
    try:
        with open(filepath) as f:
            full_text = f.read()
    except:
        return []
    text = full_text
    last_import = -1
    first_def_after = -1
    for i, line in enumerate(full_text.splitlines()):
        if line.startswith('import ') or line.startswith('from '):
            last_import = i
            first_def_after = -1
        elif first_def_after == -1 and (line.startswith('def ') or line.startswith('class ')):
            first_def_after = i
    if first_def_after > last_import and last_import >= 0:
        lines = full_text.splitlines(True)
        text = ''.join(lines[:first_def_after])
    try:
        tree = ast.parse(text)
    except:
        try:
            tree = ast.parse(full_text)
        except:
            return []
    imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append((alias.name.split('.')[0], '*'))
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.level == 0:
                mod = node.module.split('.')[0]
                for alias in node.names:
                    imports.append((mod, alias.name))
    return imports

repo_root = sys.argv[1]

skip_dirs = {'tests', 'test', 'testing', '__tests__', 'fixtures', '__pycache__', '.git', 'node_modules', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', 'build', 'dist', '.eggs'}

result = {}
for root, dirs, files in os.walk(repo_root):
    dirs[:] = [d for d in dirs if d not in skip_dirs and not d.endswith('.egg-info')]
    for f in files:
        if not f.endswith('.py'):
            continue
        if f.startswith('test_') or f.endswith('_test.py') or f == 'conftest.py':
            continue
        filepath = os.path.join(root, f)
        imports = get_imports(filepath)
        rel_dir = os.path.relpath(root, repo_root)
        for mod, specifier in imports:
            if rel_dir not in result:
                result[rel_dir] = {}
            if mod not in result[rel_dir]:
                result[rel_dir][mod] = {}
            result[rel_dir][mod][specifier] = result[rel_dir][mod].get(specifier, 0) + 1

print(json.dumps(result))
`.trim();

const PACKAGE_WALK_SKIP_DIRS = new Set([
    '.venv', 'venv', 'node_modules', '__pycache__', '.git',
    'dist', 'build', '.tox', '.eggs', '.mypy_cache', '.pytest_cache',
]);

function safeReadDir(dir: string): fs.Dirent[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

function hasInitPy(entries: fs.Dirent[]): boolean {
    return entries.some((e) => e.isFile() && e.name === '__init__.py');
}

function findInternalImportableNames(repoRoot: string): Set<string> {
    const result = new Set<string>();
    const rootEntries = safeReadDir(repoRoot);
    const rootIsPackage = hasInitPy(rootEntries);

    for (const entry of rootEntries) {
        if (!entry.isDirectory()) continue;
        if (PACKAGE_WALK_SKIP_DIRS.has(entry.name) || entry.name.endsWith('.egg-info')) continue;
        collectTopLevelPackages(path.join(repoRoot, entry.name), rootIsPackage, result);
    }

    return result;
}

function collectTopLevelPackages(dir: string, parentIsPackage: boolean, result: Set<string>): void {
    const entries = safeReadDir(dir);
    if (entries.length === 0) return;

    const isPackage = hasInitPy(entries);
    if (isPackage && !parentIsPackage) {
        result.add(path.basename(dir));
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (PACKAGE_WALK_SKIP_DIRS.has(entry.name) || entry.name.endsWith('.egg-info')) continue;
        collectTopLevelPackages(path.join(dir, entry.name), isPackage, result);
    }
}

function scanRepoImportHeatmap(repoRoot: string): Record<string, Record<string, Record<string, number>>> {
    let result: childProcess.SpawnSyncReturns<Buffer>;
    try {
        result = childProcess.spawnSync(
            'python3',
            ['-c', PYTHON_HEATMAP_SCRIPT, repoRoot],
            { encoding: 'buffer', timeout: 120000 }
        );
    } catch {
        return {};
    }

    if (result.status !== 0 || !result.stdout) {
        return {};
    }

    try {
        return JSON.parse(result.stdout.toString('utf-8').trim());
    } catch {
        return {};
    }
}

function dirBelongsToProject(repoRelDir: string, projectPath: string): boolean {
    if (projectPath === '.') return true;
    const normalizedDir = repoRelDir.replace(/\\/g, '/');
    const projectPrefix = projectPath.replace(/\\/g, '/');
    return normalizedDir === projectPrefix || normalizedDir.startsWith(projectPrefix + '/');
}

function toProjectRelativeDir(repoRelDir: string, projectPath: string): string {
    const normalizedDir = repoRelDir.replace(/\\/g, '/');
    if (projectPath === '.') return normalizedDir;
    const projectPrefix = projectPath.replace(/\\/g, '/');
    if (normalizedDir === projectPrefix) return '.';
    return normalizedDir.slice(projectPrefix.length + 1);
}

function collectProjectImportModules(
    projectPath: string,
    repoImportMap: Record<string, Record<string, Record<string, number>>>,
): Set<string> {
    const imports = new Set<string>();
    for (const [repoRelDir, modCounts] of Object.entries(repoImportMap)) {
        if (!dirBelongsToProject(repoRelDir, projectPath)) continue;
        for (const mod of Object.keys(modCounts)) {
            imports.add(mod);
        }
    }
    return imports;
}

function filterImportsForProject(
    projectPath: string,
    repoImportMap: Record<string, Record<string, Record<string, number>>>,
    internalNames: Set<string>,
): Record<string, Record<string, Record<string, number>>> {
    const result: Record<string, Record<string, Record<string, number>>> = {};
    for (const [repoRelDir, modSpecifiers] of Object.entries(repoImportMap)) {
        if (!dirBelongsToProject(repoRelDir, projectPath)) continue;
        const projectRelDir = toProjectRelativeDir(repoRelDir, projectPath);
        const filtered: Record<string, Record<string, number>> = {};
        for (const [mod, specifiers] of Object.entries(modSpecifiers)) {
            if (!internalNames.has(mod)) {
                filtered[mod] = specifiers;
            }
        }
        if (Object.keys(filtered).length > 0) {
            result[projectRelDir] = filtered;
        }
    }
    return result;
}

function discoverUndeclaredSiblingDeps(
    member: FlatProjectNode,
    allWorkspaceNames: string[],
    normalizedToOriginal: Map<string, string>,
    repoImportMap: Record<string, Record<string, Record<string, number>>>,
): void {
    const existingDeps = new Set(member.dependencies);
    const undeclaredSiblings = allWorkspaceNames.filter((n) => n !== member.name && !existingDeps.has(n));
    if (undeclaredSiblings.length === 0) return;

    const normalizedUndeclared = new Set(undeclaredSiblings.map((s) => s.replace(/-/g, '_')));
    const projectImports = collectProjectImportModules(member.path, repoImportMap);

    const discovered: string[] = [];
    for (const mod of projectImports) {
        if (!normalizedUndeclared.has(mod)) continue;
        const original = normalizedToOriginal.get(mod);
        if (original) discovered.push(original);
    }

    if (discovered.length === 0) return;
    member.dependencies = Array.from(new Set([...existingDeps, ...discovered])).sort();
}

function postProcessUvWorkspace(
    workspace: Workspace,
    repoRoot: string,
    repoImportMap: Record<string, Record<string, Record<string, number>>>
): void {
    const members = workspace.projects.filter((p) => p.parent !== null);
    if (members.length === 0) return;

    const allWorkspaceNames = workspace.projects.map((p) => p.name);
    const normalizedToOriginal = new Map<string, string>();
    for (const name of allWorkspaceNames) {
        normalizedToOriginal.set(name.replace(/-/g, '_'), name);
    }

    for (const member of members) {
        discoverUndeclaredSiblingDeps(member, allWorkspaceNames, normalizedToOriginal, repoImportMap);
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
        try {
            const parsed = parsePyprojectToml(tomlPath);
            if (parsed) {
                parsedPyprojects.push(parsed);
                pyprojectDirs.add(parsed.absDir);
            }
        } catch {
            // readToml already logged the parse error; skip this file and continue
            // so a single bad pyproject.toml doesn't kill detection for the whole repo.
        }
    }

    const parsedSetupFiles = parseSetupFiles(otherMarkers, pyprojectDirs);
    const setupDirs = new Set([...pyprojectDirs, ...parsedSetupFiles.map((p) => p.absDir)]);
    const parsedRequirements = parseRequirementsTxt(otherMarkers, setupDirs);
    const requirementsDirs = new Set([...setupDirs, ...parsedRequirements.map((p) => p.absDir)]);
    const parsedPipfiles = parsePipfile(otherMarkers, requirementsDirs);
    const allParsed = [...parsedPyprojects, ...parsedSetupFiles, ...parsedRequirements, ...parsedPipfiles];

    if (allParsed.length === 0) {
        return { tool: 'python', workspaces: [] };
    }

    const allParsedByDir = new Map<string, ParsedProject>();
    for (const p of allParsed) {
        allParsedByDir.set(p.absDir, p);
    }

    const allNameSet = new Set(allParsed.map((p) => normalizeName(p.name)));

    const uvWorkspaceRoots = allParsed.filter((p) => p.isUvWorkspaceRoot);
    const uvMemberDirs = new Set<string>();
    for (const root of uvWorkspaceRoots) {
        const memberDirs = resolveUvWorkspaceMembers(root.absDir, root.uvWorkspaceMembers);
        for (const d of memberDirs) {
            if (d !== root.absDir) {
                uvMemberDirs.add(d);
            }
        }
    }

    const workspaces: Workspace[] = [];
    const repoImportMap = scanRepoImportHeatmap(repoRoot);

    for (const root of uvWorkspaceRoots) {
        const ws = buildUvWorkspace(root, allParsedByDir, repoRoot, allNameSet);
        postProcessUvWorkspace(ws, repoRoot, repoImportMap);
        workspaces.push(ws);
    }

    const nonUvParsed = allParsed.filter(
        (p) => !p.isUvWorkspaceRoot && !uvMemberDirs.has(p.absDir)
    );

    if (nonUvParsed.length > 0) {
        const forest = buildForest(nonUvParsed, repoRoot);
        for (const treeRoot of forest) {
            const projects = flattenTreeNode(treeRoot, null, repoRoot, allNameSet);
            const rootParsed = treeRoot.parsed;
            const hasChildren = treeRoot.children.length > 0;
            workspaces.push({
                root: projects[0].path,
                type: deriveWorkspaceType(rootParsed, hasChildren),
                projects,
            });
        }
    }

    const internalNames = findInternalImportableNames(repoRoot);
    for (const workspace of workspaces) {
        for (const project of workspace.projects) {
            project.imports = filterImportsForProject(project.path, repoImportMap, internalNames);
        }
    }

    return { tool: 'python', workspaces };
}

export function detectAction(options: DetectOptions): void {
    const output = detect(options.cwd);
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}
