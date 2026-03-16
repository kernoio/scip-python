import { LsifSymbol as TypescriptScipSymbol } from './lsif-typescript/LsifSymbol';

// @ts-ignore
export class ScipSymbol extends TypescriptScipSymbol {
    constructor(value: string) {
        super(value);
    }

    public static override package(_name: string, _version: string): TypescriptScipSymbol {
        return TypescriptScipSymbol.empty();
    }
}

// See https://github.com/sourcegraph/scip/blob/main/scip.proto#L118-L121
function normalizeNameOrVersion(s: string): string {
    if (s === '') {
        return '.';
    }
    if (s.indexOf(' ') === -1) {
        return s;
    }
    return s.replace(/ /g, '  ');
}
