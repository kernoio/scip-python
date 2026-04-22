import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detect } from './detectCommand';

function makeTempProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scip-detect-test-'));
    for (const [relPath, content] of Object.entries(files)) {
        const fullPath = path.join(dir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
    }
    return dir;
}

describe('detectCommand', () => {
    describe('pyproject.toml', () => {
        test('detects project with plain dependencies array', () => {
            const dir = makeTempProject({
                'pyproject.toml': [
                    '[project]',
                    'name = "plain-project"',
                    'version = "1.0"',
                    'dependencies = ["requests==2.31.0"]',
                    '',
                    '[build-system]',
                    'requires = ["setuptools"]',
                    'build-backend = "setuptools.build_meta"',
                ].join('\n'),
            });
            try {
                const output = detect(dir);
                expect(output.workspaces).toHaveLength(1);
                expect(output.workspaces[0].projects).toHaveLength(1);
                expect(output.workspaces[0].projects[0].name).toBe('plain-project');
                expect(output.workspaces[0].projects[0].buildTool).toBe('setuptools');
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        test('detects project with PEP 735 heterogeneous dependency-groups', () => {
            const dir = makeTempProject({
                'pyproject.toml': [
                    '[build-system]',
                    'requires = ["hatchling"]',
                    'build-backend = "hatchling.build"',
                    '',
                    '[project]',
                    'name = "pep735-project"',
                    'version = "1.0"',
                    'dependencies = ["fastapi==0.121.0"]',
                    '',
                    '[dependency-groups]',
                    'dev = [',
                    '    "ruff==0.12.5",',
                    '    "slotscheck==0.19.1",',
                    '    { include-group = "test" },',
                    ']',
                    'test = ["pytest==8.4.1"]',
                ].join('\n'),
            });
            try {
                const output = detect(dir);
                expect(output.workspaces).toHaveLength(1);
                expect(output.workspaces[0].projects).toHaveLength(1);
                expect(output.workspaces[0].projects[0].name).toBe('pep735-project');
                expect(output.workspaces[0].projects[0].buildTool).toBe('hatchling');
                expect(output.workspaces[0].projects[0].languages).toEqual(['python']);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});
