import { scip } from './scip';

const VIEWSET_MARKERS = [
    'ModelViewSet#',
    'GenericViewSet#',
    'CreateModelMixin#',
    'UpdateModelMixin#',
    'DestroyModelMixin#',
    'GenericAPIView#',
];

const FIELD_TO_BASE: Record<string, string> = {
    'serializer_class.': '`rest_framework.serializers`/BaseSerializer#',
    'queryset.': '`django.db.models.base`/Model#',
};

export function refineViewSetTypes(doc: scip.Document): void {
    for (const classRange of findViewSetClasses(doc)) {
        const substitutions = buildSubstitutions(doc, classRange);
        applySubstitutions(doc, classRange, substitutions);
    }
}

interface ClassRange {
    startLine: number;
    endLine: number;
}

function findViewSetClasses(doc: scip.Document): ClassRange[] {
    const results: ClassRange[] = [];

    for (const occ of doc.occurrences) {
        if (!occ.enclosing_range || occ.enclosing_range.length === 0) continue;
        if ((occ.symbol_roles & 1) === 0) continue;

        const isViewSet = doc.occurrences.some(
            other => other.range[0] === occ.range[0]
                && VIEWSET_MARKERS.some(marker => other.symbol.includes(marker))
        );

        if (!isViewSet) continue;

        results.push({
            startLine: occ.enclosing_range[0],
            endLine: occ.enclosing_range[2] ?? occ.enclosing_range[0],
        });
    }

    return results;
}

interface Substitution {
    basePrefix: string;
    concretePrefix: string;
}

function buildSubstitutions(doc: scip.Document, classRange: ClassRange): Substitution[] {
    const substitutions: Substitution[] = [];

    for (const occ of doc.occurrences) {
        if (occ.range[0] < classRange.startLine || occ.range[0] > classRange.endLine) continue;
        if ((occ.symbol_roles & 1) === 0) continue;

        for (const [fieldSuffix, basePrefix] of Object.entries(FIELD_TO_BASE)) {
            if (!occ.symbol.endsWith(fieldSuffix)) continue;

            const concreteClass = doc.occurrences.find(
                other => other.range[0] === occ.range[0]
                    && (other.symbol_roles & 1) === 0
                    && other.symbol.endsWith('#')
            );

            if (!concreteClass) continue;

            substitutions.push({ basePrefix, concretePrefix: concreteClass.symbol.slice(0, -1) + '#' });
        }
    }

    return substitutions;
}

function applySubstitutions(doc: scip.Document, classRange: ClassRange, substitutions: Substitution[]): void {
    if (substitutions.length === 0) return;

    for (const occ of doc.occurrences) {
        if (occ.range[0] < classRange.startLine || occ.range[0] > classRange.endLine) continue;

        for (const sub of substitutions) {
            if (occ.symbol.includes(sub.basePrefix)) {
                occ.symbol = occ.symbol.replace(sub.basePrefix, sub.concretePrefix);
            }
        }
    }
}
