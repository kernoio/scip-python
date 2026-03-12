import {
    AnyType,
    ClassType,
    FunctionType,
    OverloadedType,
    Type,
    TypeCategory,
    TypeCondition,
    UnionType,
    findSubtype,
    TypeVarType,
    ModuleType,
    isParamSpec,
    isTypeVarTuple,
} from 'pyright-internal/analyzer/types';
import { ParamCategory } from 'pyright-internal/parser/parseNodes';

const maxTypeRecursionCount = 30;

export function isTypeImplementable(
    type1: Type,
    type2: Type,
    ignorePseudoGeneric = false,
    ignoreTypeFlags = false,
    recursionCount = 0,
    isSelfSame = false
): boolean {
    if (type1 === type2) {
        return true;
    }

    if (type1.category !== type2.category) {
        return false;
    }

    if (!ignoreTypeFlags && type1.flags !== type2.flags) {
        return false;
    }

    if (recursionCount > maxTypeRecursionCount) {
        return true;
    }
    recursionCount++;

    switch (type1.category) {
        case TypeCategory.Class: {
            const classType2 = type2 as ClassType;

            if (!ClassType.isSameGenericClass(type1, classType2, recursionCount)) {
                return false;
            }

            if (!TypeCondition.isSame(type1.props?.condition, type2.props?.condition)) {
                return false;
            }

            if (!ignorePseudoGeneric || !ClassType.isPseudoGenericClass(type1)) {
                if (type1.priv.tupleTypeArgs && classType2.priv.tupleTypeArgs) {
                    const type1TupleTypeArgs = type1.priv.tupleTypeArgs || [];
                    const type2TupleTypeArgs = classType2.priv.tupleTypeArgs || [];
                    if (type1TupleTypeArgs.length !== type2TupleTypeArgs.length) {
                        return false;
                    }

                    for (let i = 0; i < type1TupleTypeArgs.length; i++) {
                        if (
                            !isTypeImplementable(
                                type1TupleTypeArgs[i].type,
                                type2TupleTypeArgs[i].type,
                                ignorePseudoGeneric,
                                false,
                                recursionCount,
                                isSelfSame
                            )
                        ) {
                            return false;
                        }

                        if (type1TupleTypeArgs[i].isUnbounded !== type2TupleTypeArgs[i].isUnbounded) {
                            return false;
                        }
                    }
                } else {
                    const type1TypeArgs = type1.priv.typeArgs || [];
                    const type2TypeArgs = classType2.priv.typeArgs || [];
                    const typeArgCount = Math.max(type1TypeArgs.length, type2TypeArgs.length);

                    for (let i = 0; i < typeArgCount; i++) {
                        const typeArg1 = i < type1TypeArgs.length ? type1TypeArgs[i] : AnyType.create();
                        const typeArg2 = i < type2TypeArgs.length ? type2TypeArgs[i] : AnyType.create();

                        if (
                            !isTypeImplementable(
                                typeArg1,
                                typeArg2,
                                ignorePseudoGeneric,
                                false,
                                recursionCount,
                                isSelfSame
                            )
                        ) {
                            return false;
                        }
                    }
                }
            }

            if (!ClassType.isLiteralValueSame(type1, classType2)) {
                return false;
            }

            return true;
        }

        case TypeCategory.Function: {
            const functionType2 = type2 as FunctionType;
            const params1 = type1.shared.parameters;
            const params2 = functionType2.shared.parameters;

            if (params1.length !== params2.length) {
                return false;
            }

            const positionalOnlyIndex1 = params1.findIndex(
                (param) => param.category === ParamCategory.Simple && !param.name
            );
            const positionalOnlyIndex2 = params2.findIndex(
                (param) => param.category === ParamCategory.Simple && !param.name
            );

            for (let i = 0; i < params1.length; i++) {
                const param1 = params1[i];
                const param2 = params2[i];

                if (param1.category !== param2.category) {
                    return false;
                }

                const isName1Relevant = positionalOnlyIndex1 !== undefined && i >= positionalOnlyIndex1;
                const isName2Relevant = positionalOnlyIndex2 !== undefined && i >= positionalOnlyIndex2;

                if (isName1Relevant !== isName2Relevant) {
                    return false;
                }

                if (isName1Relevant) {
                    if (param1.name !== param2.name) {
                        return false;
                    }
                }

                const param1Type = FunctionType.getParamType(type1, i);
                const param2Type = FunctionType.getParamType(functionType2, i);
                if (
                    !isTypeImplementable(
                        param1Type,
                        param2Type,
                        ignorePseudoGeneric,
                        false,
                        recursionCount,
                        isSelfSame
                    )
                ) {
                    return false;
                }
            }

            let return1Type = type1.shared.declaredReturnType;
            if (type1.priv.specializedTypes && type1.priv.specializedTypes.returnType) {
                return1Type = type1.priv.specializedTypes.returnType;
            }
            if (!return1Type && type1.shared.inferredReturnType) {
                return1Type = type1.shared.inferredReturnType.type;
            }

            let return2Type = functionType2.shared.declaredReturnType;
            if (functionType2.priv.specializedTypes && functionType2.priv.specializedTypes.returnType) {
                return2Type = functionType2.priv.specializedTypes.returnType;
            }
            if (!return2Type && functionType2.shared.inferredReturnType) {
                return2Type = functionType2.shared.inferredReturnType.type;
            }

            if (return1Type || return2Type) {
                if (
                    !return1Type ||
                    !return2Type ||
                    !isTypeImplementable(
                        return1Type,
                        return2Type,
                        ignorePseudoGeneric,
                        false,
                        recursionCount
                    )
                ) {
                    return false;
                }
            }

            return true;
        }

        case TypeCategory.Overloaded: {
            const functionType2 = type2 as OverloadedType;
            if (OverloadedType.getOverloads(type1).length !== OverloadedType.getOverloads(functionType2).length) {
                return false;
            }

            const overloads1 = OverloadedType.getOverloads(type1);
            const overloads2 = OverloadedType.getOverloads(functionType2);

            for (let i = 0; i < overloads1.length; i++) {
                if (
                    !isTypeImplementable(
                        overloads1[i],
                        overloads2[i],
                        ignorePseudoGeneric,
                        ignoreTypeFlags,
                        recursionCount
                    )
                ) {
                    return false;
                }
            }

            return true;
        }

        case TypeCategory.Union: {
            const unionType1 = type1 as UnionType;
            const unionType2 = type2 as UnionType;
            const subtypes1 = unionType1.priv.subtypes;
            const subtypes2 = unionType2.priv.subtypes;

            if (subtypes1.length !== subtypes2.length) {
                return false;
            }

            return (
                findSubtype(
                    type1,
                    (subtype) => !UnionType.containsType(unionType2, subtype, {}, undefined, recursionCount)
                ) === undefined
            );
        }

        case TypeCategory.TypeVar: {
            const type2TypeVar = type2 as TypeVarType;

            if (isSelfSame && type1.shared.isSynthesizedSelf && type2TypeVar.shared.isSynthesizedSelf) {
                return true;
            }

            if (type1.priv.scopeId !== type2TypeVar.priv.scopeId) {
                return false;
            }

            if (type1.shared.recursiveAlias && type2TypeVar.shared.recursiveAlias) {
                const type1TypeArgs = type1?.props?.typeAliasInfo?.typeArgs || [];
                const type2TypeArgs = type2?.props?.typeAliasInfo?.typeArgs || [];
                const typeArgCount = Math.max(type1TypeArgs.length, type2TypeArgs.length);

                for (let i = 0; i < typeArgCount; i++) {
                    const typeArg1 = i < type1TypeArgs.length ? type1TypeArgs[i] : AnyType.create();
                    const typeArg2 = i < type2TypeArgs.length ? type2TypeArgs[i] : AnyType.create();

                    if (
                        !isTypeImplementable(
                            typeArg1,
                            typeArg2,
                            ignorePseudoGeneric,
                            false,
                            recursionCount
                        )
                    ) {
                        return false;
                    }
                }
            }

            if (type1.shared === type2TypeVar.shared) {
                return true;
            }

            if (isParamSpec(type1) !== isParamSpec(type2TypeVar)) {
                return false;
            }

            if (isTypeVarTuple(type1) !== isTypeVarTuple(type2TypeVar)) {
                return false;
            }

            if (
                type1.shared.name !== type2TypeVar.shared.name ||
                type1.shared.isSynthesized !== type2TypeVar.shared.isSynthesized ||
                type1.shared.declaredVariance !== type2TypeVar.shared.declaredVariance ||
                type1.priv.scopeId !== type2TypeVar.priv.scopeId
            ) {
                return false;
            }

            const boundType1 = type1.shared.boundType;
            const boundType2 = type2TypeVar.shared.boundType;
            if (boundType1) {
                if (
                    !boundType2 ||
                    !isTypeImplementable(
                        boundType1,
                        boundType2,
                        ignorePseudoGeneric,
                        false,
                        recursionCount
                    )
                ) {
                    return false;
                }
            } else {
                if (boundType2) {
                    return false;
                }
            }

            const constraints1 = type1.shared.constraints;
            const constraints2 = type2TypeVar.shared.constraints;
            if (constraints1.length !== constraints2.length) {
                return false;
            }

            for (let i = 0; i < constraints1.length; i++) {
                if (
                    !isTypeImplementable(
                        constraints1[i],
                        constraints2[i],
                        ignorePseudoGeneric,
                        false,
                        recursionCount
                    )
                ) {
                    return false;
                }
            }

            return true;
        }

        case TypeCategory.Module: {
            const type2Module = type2 as ModuleType;

            if (type1.priv.fields === type2Module.priv.fields) {
                return true;
            }

            if (type1.priv.fields.size === 0 && type2Module.priv.fields.size === 0) {
                return true;
            }

            return false;
        }
    }

    return true;
}
