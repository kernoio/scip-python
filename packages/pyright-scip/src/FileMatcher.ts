import { ConfigOptions } from 'pyright-internal/common/configOptions';
import { FileSystem } from 'pyright-internal/common/fileSystem';
import { FileSpec, getFileSystemEntries, tryRealpath, tryStat } from 'pyright-internal/common/uri/uriUtils';
import { Uri } from 'pyright-internal/common/uri/uri';

const _includeFileRegex = /\.pyi?$/;

export class FileMatcher {
    private _console: any;

    constructor(private _configOptions: ConfigOptions, private _fs: FileSystem) {
        this._console = console;
    }

    public matchFiles(include: FileSpec[], exclude: FileSpec[]): string[] {
        const envMarkers = [['bin', 'activate'], ['Scripts', 'activate'], ['pyvenv.cfg']];
        const results: string[] = [];
        const startTime = Date.now();
        const longOperationLimitInSec = 10;
        let loggedLongOperationError = false;

        const visitDirectoryUnchecked = (dirUri: Uri, includeRegExp: RegExp) => {
            if (!loggedLongOperationError) {
                const secondsSinceStart = (Date.now() - startTime) * 0.001;

                if (secondsSinceStart >= longOperationLimitInSec) {
                    this._console.error(
                        `Enumeration of workspace source files is taking longer than ${longOperationLimitInSec} seconds.\n` +
                            'This may be because:\n' +
                            '* You have opened your home directory or entire hard drive as a workspace\n' +
                            '* Your workspace contains a very large number of directories and files\n' +
                            '* Your workspace contains a symlink to a directory with many files\n' +
                            '* Your workspace is remote, and file enumeration is slow\n' +
                            'To reduce this time, open a workspace directory with fewer files ' +
                            'or add a pyrightconfig.json configuration file with an "exclude" section to exclude ' +
                            'subdirectories from your workspace. For more details, refer to ' +
                            'https://github.com/microsoft/pyright/blob/main/docs/configuration.md.'
                    );
                    loggedLongOperationError = true;
                }
            }

            if (this._configOptions.autoExcludeVenv) {
                if (envMarkers.some((f) => this._fs.existsSync(dirUri.combinePaths(...f)))) {
                    this._console.info(`Auto-excluding ${dirUri.getFilePath()}`);
                    return;
                }
            }

            const { files, directories } = getFileSystemEntries(this._fs, dirUri);

            for (const fileUri of files) {
                if (this._matchIncludeFileSpec(includeRegExp, exclude, fileUri)) {
                    results.push(fileUri.getFilePath());
                }
            }

            for (const subDirUri of directories) {
                if (subDirUri.matchesRegex(includeRegExp)) {
                    if (!FileSpec.isInPath(subDirUri, exclude)) {
                        visitDirectory(subDirUri, includeRegExp);
                    }
                }
            }
        };

        const seenDirs = new Set<string>();
        const visitDirectory = (dirUri: Uri, includeRegExp: RegExp) => {
            const realDirUri = tryRealpath(this._fs, dirUri);
            if (!realDirUri) {
                this._console.warn(`Skipping broken link "${dirUri.getFilePath()}"`);
                return;
            }

            const realDirPath = realDirUri.getFilePath();
            if (seenDirs.has(realDirPath)) {
                this._console.warn(`Skipping recursive symlink "${dirUri.getFilePath()}" -> "${realDirPath}"`);
                return;
            }
            seenDirs.add(realDirPath);

            try {
                visitDirectoryUnchecked(dirUri, includeRegExp);
            } finally {
                seenDirs.delete(realDirPath);
            }
        };

        include.forEach((includeSpec) => {
            if (!FileSpec.isInPath(includeSpec.wildcardRoot, exclude)) {
                let foundFileSpec = false;

                const stat = tryStat(this._fs, includeSpec.wildcardRoot);
                if (stat?.isFile()) {
                    if (this._shouldIncludeFile(includeSpec.wildcardRoot)) {
                        results.push(includeSpec.wildcardRoot.getFilePath());
                        foundFileSpec = true;
                    }
                } else if (stat?.isDirectory()) {
                    visitDirectory(includeSpec.wildcardRoot, includeSpec.regExp);
                    foundFileSpec = true;
                }

                if (!foundFileSpec) {
                    this._console.error(`File or directory "${includeSpec.wildcardRoot.getFilePath()}" does not exist.`);
                }
            }
        });

        return results;
    }

    private _matchIncludeFileSpec(includeRegExp: RegExp, exclude: FileSpec[], fileUri: Uri) {
        if (fileUri.matchesRegex(includeRegExp)) {
            if (!FileSpec.isInPath(fileUri, exclude) && this._shouldIncludeFile(fileUri)) {
                return true;
            }
        }

        return false;
    }

    private _shouldIncludeFile(fileUri: Uri) {
        return fileUri.matchesRegex(_includeFileRegex);
    }
}
