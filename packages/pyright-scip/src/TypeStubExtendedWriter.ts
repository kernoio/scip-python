import { SourceFile } from 'pyright-internal/analyzer/sourceFile';
import { TypeEvaluator } from 'pyright-internal/analyzer/typeEvaluatorTypes';
import {
    ClassType,
    isFunction,
    isInstantiableClass,
    isNever,
    isUnknown,
    removeUnknownFromUnion,
} from 'pyright-internal/analyzer/types';
import { TypeStubWriter } from 'pyright-internal/analyzer/typeStubWriter';
import {
    ArgCategory,
    AssignmentNode,
    ClassNode,
    DecoratorNode,
    ExpressionNode,
    FunctionNode,
    ParamCategory,
    ParameterNode,
    ParseNodeType,
} from 'pyright-internal/parser/parseNodes';
import * as TypeUtils from 'pyright-internal/analyzer/typeUtils';
import * as ParseTreeUtils from 'pyright-internal/analyzer/parseTreeUtils';
import { Uri } from 'pyright-internal/common/uri/uri';

// @ts-ignore
export class TypeStubExtendedWriter extends TypeStubWriter {
    public docstrings: Map<number, string[]>;

    constructor(sourceFile: SourceFile, public evaluator: TypeEvaluator) {
        super(Uri.empty(), sourceFile, evaluator);

        this.docstrings = new Map<number, string[]>();
    }

    override visitClass(node: ClassNode): boolean {
        const className = node.d.name.d.value;

        let line = '';
        line += this._printDecorators(node.d.decorators);
        line += `class ${className}`;

        const args = node.d.arguments.filter(
            (arg) =>
                arg.d.name !== undefined ||
                arg.d.argCategory !== ArgCategory.Simple ||
                arg.d.valueExpr.nodeType !== ParseNodeType.Name ||
                arg.d.valueExpr.d.value !== 'object'
        );

        if (args.length > 0) {
            line += `(${args
                .map((arg) => {
                    let argString = '';
                    if (arg.d.name) {
                        argString = arg.d.name.d.value + '=';
                    }
                    argString += this._printExpression(arg.d.valueExpr);
                    return argString;
                })
                .join(', ')})`;
        }
        line += ':';

        this.docstrings.set(node.id, [line]);

        return false;
    }

    override visitFunction(node: FunctionNode): boolean {
        const functionName = node.d.name.d.value;
        let line = '';
        line += this._printDecorators(node.d.decorators);
        line += node.d.isAsync ? 'async ' : '';
        line += `def ${functionName}`;

        const mappedParameters = node.d.params.map((param, index) => this._printParameter(param, node, index));
        if (mappedParameters.length <= 0) {
            line += `(${mappedParameters.join(', ')})`;
        } else {
            line += `(\n  ${mappedParameters.join(',\n  ')}\n)`;
        }

        let returnAnnotation: string | undefined;
        if (node.d.returnAnnotation) {
            returnAnnotation = this._printExpression(node.d.returnAnnotation, /* treatStringsAsSymbols */ true);
        } else if (node.d.funcAnnotationComment) {
            returnAnnotation = this._printExpression(
                node.d.funcAnnotationComment.d.returnAnnotation,
                /* treatStringsAsSymbols */ true
            );
        } else {
            if (node.d.name.d.value === '__init__') {
                returnAnnotation = 'None';
            } else if (node.d.name.d.value === '__str__') {
                returnAnnotation = 'str';
            } else if (['__int__', '__hash__'].some((name) => name === node.d.name.d.value)) {
                returnAnnotation = 'int';
            } else if (
                ['__eq__', '__ne__', '__gt__', '__lt__', '__ge__', '__le__'].some((name) => name === node.d.name.d.value)
            ) {
                returnAnnotation = 'bool';
            }
        }

        if (returnAnnotation) {
            line += ' -> ' + returnAnnotation;
        }

        line += ':';

        if (!returnAnnotation) {
            const functionType = this.evaluator.getTypeOfFunction(node);
            if (functionType && isFunction(functionType.functionType)) {
                let returnType = this.evaluator.getInferredReturnType(functionType.functionType);
                returnType = removeUnknownFromUnion(returnType);
                if (!isNever(returnType) && !isUnknown(returnType)) {
                    line += ` # -> ${this.evaluator.printType(returnType, { expandTypeAlias: false })}:`;
                }
            }
        }

        this.docstrings.set(node.id, [line]);

        return true;
    }

    override visitAssignment(node: AssignmentNode): boolean {
        let isTypeAlias = false;
        let line = '';

        if (node.d.leftExpr.nodeType === ParseNodeType.Name) {
            const valueType = this.evaluator.getType(node.d.leftExpr);

            if (node.d.annotationComment) {
                line += this._printExpression(node.d.annotationComment, /* treatStringsAsSymbols */ true);
            } else if (valueType) {
                line += TypeUtils.getFullNameOfType(valueType);
            }

            if (valueType?.props?.typeAliasInfo) {
                isTypeAlias = true;
            } else if (node.d.rightExpr.nodeType === ParseNodeType.Call) {
                const callBaseType = this.evaluator.getType(node.d.rightExpr.d.leftExpr);
                if (
                    callBaseType &&
                    isInstantiableClass(callBaseType) &&
                    ClassType.isBuiltIn(callBaseType, ['TypeVar', 'TypeVarTuple', 'ParamSpec', 'NewType'])
                ) {
                    isTypeAlias = true;
                }
            }
        }

        if (line) {
            if (isTypeAlias) {
                line += ' = ';
                line += this._printExpression(node.d.rightExpr);
            }

            this.docstrings.set(node.id, [line]);
        }

        return true;
    }

    private _printParameter(paramNode: ParameterNode, functionNode: FunctionNode, paramIndex: number): string {
        let line = '';
        if (paramNode.d.category === ParamCategory.ArgsList) {
            line += '*';
        } else if (paramNode.d.category === ParamCategory.KwargsDict) {
            line += '**';
        }

        if (paramNode.d.name) {
            line += paramNode.d.name.d.value;
        }

        const paramTypeAnnotation = ParseTreeUtils.getTypeAnnotationForParam(functionNode, paramIndex);

        let paramType = '';
        if (paramTypeAnnotation) {
            paramType = this._printExpression(paramTypeAnnotation, /* treatStringsAsSymbols */ true);
        }

        if (paramType) {
            line += ': ' + paramType;
        }

        if (paramNode.d.defaultValue) {
            if (paramType) {
                line += ' = ';
            } else {
                line += '=';
            }
            line += this._printExpression(paramNode.d.defaultValue!, false, true);
        }

        return line;
    }

    override _printExpression(node: ExpressionNode, isType = false, treatStringsAsSymbols = false): string {
        // @ts-ignore
        return super._printExpression(node, isType, treatStringsAsSymbols);
    }

    private _printDecorators(decorators: DecoratorNode[]) {
        let line = '';
        decorators.forEach((decorator) => {
            line += '@' + this._printExpression(decorator.d.expr) + '\n';
        });

        return line;
    }
}
