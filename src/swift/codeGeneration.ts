import {
  GraphQLError,
  GraphQLType,
  getNamedType,
  isCompositeType,
  GraphQLEnumType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLInputObjectType
} from 'graphql';

import {
  CompilerContext,
  Operation,
  Fragment,
  SelectionSet,
  Field,
  TypeCondition,
  FragmentSpread
} from '../compiler';

import { TypeCase } from '../compiler/flattenIR';

import { join, wrap } from '../utilities/printing';

import { SwiftGenerator, Property, escapeIdentifierIfNeeded, Struct } from './language';
import { Helpers } from './helpers';
import { isList } from '../utilities/graphql';

import { collectFragmentsReferenced } from '../compiler/visitors/collectFragmentsReferenced';
import { mergeInFragmentSpreads } from '../compiler/visitors/mergeInFragmentSpreads';
import { generateOperationId } from '../compiler/visitors/generateOperationId';
import { inlineRedundantTypeConditions } from '../compiler/visitors/inlineRedundantTypeConditions';

export interface Options {
  namespace?: string;
  passthroughCustomScalars?: boolean;
  customScalarsPrefix?: string;
}

export function generateSource(context: CompilerContext) {
  const generator = new SwiftAPIGenerator(context);

  generator.fileHeader();

  generator.namespaceDeclaration(context.options.namespace, () => {
    context.typesUsed.forEach(type => {
      generator.typeDeclarationForGraphQLType(type);
    });

    Object.values(context.operations).forEach(operation => {
      generator.classDeclarationForOperation(operation);
    });

    Object.values(context.fragments).forEach(fragment => {
      generator.structDeclarationForFragment(fragment);
    });
  });

  return generator.output;
}

export class SwiftAPIGenerator extends SwiftGenerator<CompilerContext> {
  helpers: Helpers;

  constructor(context: CompilerContext) {
    super(context);

    this.helpers = new Helpers(context.options);
  }

  fileHeader() {
    this.printOnNewline('//  This file was automatically generated and should not be edited.');
    this.printNewline();
    this.printOnNewline('import Apollo');
  }

  classDeclarationForOperation(operation: Operation) {
    const { operationName, operationType, variables, source, selectionSet } = operation;

    let className;
    let protocol;

    switch (operationType) {
      case 'query':
        className = `${this.helpers.operationClassName(operationName)}Query`;
        protocol = 'GraphQLQuery';
        break;
      case 'mutation':
        className = `${this.helpers.operationClassName(operationName)}Mutation`;
        protocol = 'GraphQLMutation';
        break;
      default:
        throw new GraphQLError(`Unsupported operation type "${operationType}"`);
    }

    this.classDeclaration(
      {
        className,
        modifiers: ['public', 'final'],
        adoptedProtocols: [protocol]
      },
      () => {
        if (source) {
          this.printOnNewline('public static let operationString =');
          this.withIndent(() => {
            this.multilineString(source);
          });
        }

        const fragmentsReferenced = collectFragmentsReferenced(this.context, operation.selectionSet);

        if (this.context.options.generateOperationIds) {
          const { operationId } = generateOperationId(this.context, operation, fragmentsReferenced);
          this.printNewlineIfNeeded();
          this.printOnNewline(`public static let operationIdentifier: String? = "${operationId}"`);
        }

        if (fragmentsReferenced.size > 0) {
          this.printNewlineIfNeeded();
          this.printOnNewline('public static var requestString: String { return operationString');
          fragmentsReferenced.forEach(fragmentName => {
            this.print(`.appending(${this.helpers.structNameForFragmentName(fragmentName)}.fragmentString)`);
          });
          this.print(' }');
        }

        this.printNewlineIfNeeded();

        if (variables && variables.length > 0) {
          const properties = variables.map(({ name, type }) => {
            const typeName = this.helpers.typeNameFromGraphQLType(type);
            const isOptional = !(
              type instanceof GraphQLNonNull ||
              (type instanceof GraphQLList && type.ofType instanceof GraphQLNonNull)
            );
            return { name, propertyName: name, type, typeName, isOptional };
          });

          this.propertyDeclarations(properties);

          this.printNewlineIfNeeded();
          this.initializerDeclarationForProperties(properties);

          this.printNewlineIfNeeded();
          this.printOnNewline(`public var variables: GraphQLMap?`);
          this.withinBlock(() => {
            this.printOnNewline(
              wrap(
                `return [`,
                join(properties.map(({ name, propertyName }) => `"${name}": ${propertyName}`), ', ') || ':',
                `]`
              )
            );
          });
        } else {
          this.initializerDeclarationForProperties([]);
        }

        this.structDeclarationForSelectionSet({
          structName: 'Data',
          selectionSet
        });
      }
    );
  }

  structDeclarationForFragment({ fragmentName, selectionSet, source }: Fragment) {
    const structName = this.helpers.structNameForFragmentName(fragmentName);

    this.structDeclarationForSelectionSet(
      {
        structName,
        adoptedProtocols: ['GraphQLFragment'],
        selectionSet
      },
      () => {
        if (source) {
          this.printOnNewline('public static let fragmentString =');
          this.withIndent(() => {
            this.multilineString(source);
          });
        }
      }
    );
  }

  structDeclarationForSelectionSet(
    {
      structName,
      adoptedProtocols = ['GraphQLSelectionSet'],
      selectionSet
    }: {
      structName: string;
      adoptedProtocols?: string[];
      selectionSet: SelectionSet;
    },
    beforeClosure?: Function
  ) {
    this.structDeclaration({ structName, adoptedProtocols }, () => {
      if (beforeClosure) {
        beforeClosure();
      }

      const possibleTypes = selectionSet.possibleTypes;

      this.printNewlineIfNeeded();
      this.printOnNewline('public static let possibleTypes = [');
      this.print(join(possibleTypes.map(type => `"${type.name}"`), ', '));
      this.print(']');

      this.printNewlineIfNeeded();
      this.printOnNewline('public static let selections: [GraphQLSelection] = ');
      this.selectionSetInitialization(selectionSet);

      this.printNewlineIfNeeded();

      this.propertyDeclaration({
        propertyName: 'snapshot',
        typeName: 'Snapshot'
      });

      this.printNewlineIfNeeded();
      this.printOnNewline('public init(snapshot: Snapshot)');
      this.withinBlock(() => {
        this.printOnNewline(`self.snapshot = snapshot`);
      });

      const typeCase = new TypeCase(
        inlineRedundantTypeConditions(this.context, mergeInFragmentSpreads(this.context, selectionSet))
      );

      this.initializersForTypeCase(typeCase);

      const fields = typeCase.default.fields.map(field => this.helpers.propertyFromField(field as Field));

      const typeConditions = selectionSet.selections
        .filter((selection): selection is TypeCondition => selection.kind === 'TypeCondition')
        .map(this.helpers.propertyFromTypeCondition, this.helpers);

      // FIXME: Remove cast to FragmentSpread[] when proper typings for filter() land in TypeScript
      const fragmentSpreads = (selectionSet.selections.filter(
        (selection): selection is FragmentSpread => selection.kind === 'FragmentSpread'
      ) as FragmentSpread[]).map(fragmentSpread => {
        const fragment = this.context.fragmentNamed(fragmentSpread.fragmentName);
        const isConditional = selectionSet.possibleTypes.some(
          type => !fragment.selectionSet.possibleTypes.includes(type)
        );
        return this.helpers.propertyFromFragmentSpread(fragmentSpread, isConditional);
      });

      fields.forEach(this.propertyDeclarationForField, this);

      typeConditions.forEach(this.propertyDeclarationForTypeCondition, this);

      if (fragmentSpreads.length > 0) {
        this.printNewlineIfNeeded();
        this.printOnNewline(`public var fragments: Fragments`);
        this.withinBlock(() => {
          this.printOnNewline('get');
          this.withinBlock(() => {
            this.printOnNewline(`return Fragments(snapshot: snapshot)`);
          });
          this.printOnNewline('set');
          this.withinBlock(() => {
            this.printOnNewline(`snapshot = newValue.snapshot`);
          });
        });
      }

      for (const typeCondition of typeConditions) {
        this.structDeclarationForSelectionSet({
          structName: typeCondition.structName,
          adoptedProtocols: ['GraphQLFragment'],
          selectionSet: typeCondition.selectionSet
        });
      }

      if (fragmentSpreads.length > 0) {
        this.structDeclaration(
          {
            structName: 'Fragments'
          },
          () => {
            this.propertyDeclaration({
              propertyName: 'snapshot',
              typeName: 'Snapshot'
            });

            for (const fragmentSpread of fragmentSpreads) {
              const { propertyName, typeName, structName, isConditional } = fragmentSpread;

              this.printNewlineIfNeeded();
              this.printOnNewline(`public var ${escapeIdentifierIfNeeded(propertyName)}: ${typeName}`);
              this.withinBlock(() => {
                this.printOnNewline('get');
                this.withinBlock(() => {
                  if (isConditional) {
                    this.printOnNewline(
                      `if !${structName}.possibleTypes.contains(snapshot["__typename"]! as! String) { return nil }`
                    );
                  }
                  this.printOnNewline(`return ${structName}(snapshot: snapshot)`);
                });
                this.printOnNewline('set');
                this.withinBlock(() => {
                  if (isConditional) {
                    this.printOnNewline(`guard let newValue = newValue else { return }`);
                    this.printOnNewline(`snapshot = newValue.snapshot`);
                  } else {
                    this.printOnNewline(`snapshot = newValue.snapshot`);
                  }
                });
              });
            }
          }
        );
      }

      for (const field of fields) {
        if (isCompositeType(getNamedType(field.type)) && field.selectionSet) {
          this.structDeclarationForSelectionSet({
            structName: field.structName,
            selectionSet: field.selectionSet
          });
        }
      }
    });
  }

  initializersForTypeCase(typeCase: TypeCase) {
    const records = typeCase.records;

    const propertiesForFields = (fields: Field[], namespace?: string): (Field & Property)[] => {
      return fields
        .filter(field => field.name != '__typename')
        .map(field => this.helpers.propertyFromField(field, namespace));
    };

    if (records.length == 1 && records[0].possibleTypes.length == 1) {
      this.printNewlineIfNeeded();
      this.printOnNewline(`public init`);

      const properties = propertiesForFields(records[0].fields);

      this.parametersForProperties(properties);

      this.withinBlock(() => {
        this.printOnNewline(
          wrap(
            `self.init(snapshot: [`,
            join(
              [
                `"__typename": "${records[0].possibleTypes[0]}"`,
                ...properties.map(
                  ({ responseKey, propertyName }) =>
                    `"${responseKey}": ${escapeIdentifierIfNeeded(propertyName)}`
                )
              ],
              ', '
            ) || ':',
            `])`
          )
        );
      });
    } else {
      for (const record of records) {
        const structName = this.scope.typeName;

        for (const possibleType of record.possibleTypes) {
          // FIXME: Make sure there is a struct for possibleType
          const properties = propertiesForFields(
            record.fields,
            records.length > 1 ? this.helpers.structNameForTypeCondition(possibleType) : undefined
          );

          this.printNewlineIfNeeded();
          this.printOnNewline(`public static func make${possibleType}`);

          this.parametersForProperties(properties);

          this.print(` -> ${structName}`);

          this.withinBlock(() => {
            this.printOnNewline(
              wrap(
                `return ${structName}(snapshot: [`,
                join(
                  [
                    `"__typename": "${possibleType}"`,
                    ...properties.map(
                      ({ responseKey, propertyName }) =>
                        `"${responseKey}": ${escapeIdentifierIfNeeded(propertyName)}`
                    )
                  ],
                  ', '
                ) || ':',
                `])`
              )
            );
          });
        }
      }
    }
  }

  propertyDeclarationForField(field: Field & Property) {
    const { responseKey, propertyName, typeName, type, isOptional } = field;

    const unmodifiedFieldType = getNamedType(type);

    this.printNewlineIfNeeded();

    this.comment(field.description);

    this.printOnNewline(`public var ${propertyName}: ${typeName}`);
    this.withinBlock(() => {
      if (isCompositeType(unmodifiedFieldType)) {
        const structName = escapeIdentifierIfNeeded(this.helpers.structNameForPropertyName(propertyName));

        if (isList(type)) {
          this.printOnNewline('get');
          this.withinBlock(() => {
            const snapshotTypeName = this.helpers.typeNameFromGraphQLType(type, 'Snapshot', isOptional);
            let getter = `return (snapshot["${responseKey}"]! as! ${snapshotTypeName})`;
            getter += this.helpers.mapExpressionForType(type, `${structName}(snapshot: $0)`);
            this.printOnNewline(getter);
          });
          this.printOnNewline('set');
          this.withinBlock(() => {
            let newValueExpression = 'newValue' + this.helpers.mapExpressionForType(type, `$0.snapshot`);
            this.printOnNewline(`snapshot.updateValue(${newValueExpression}, forKey: "${responseKey}")`);
          });
        } else {
          this.printOnNewline('get');
          this.withinBlock(() => {
            if (isOptional) {
              this.printOnNewline(
                `return (snapshot["${responseKey}"]! as! Snapshot?).flatMap { ${structName}(snapshot: $0) }`
              );
            } else {
              this.printOnNewline(`return ${structName}(snapshot: snapshot["${responseKey}"]! as! Snapshot)`);
            }
          });
          this.printOnNewline('set');
          this.withinBlock(() => {
            let newValueExpression;
            if (isOptional) {
              newValueExpression = 'newValue?.snapshot';
            } else {
              newValueExpression = 'newValue.snapshot';
            }
            this.printOnNewline(`snapshot.updateValue(${newValueExpression}, forKey: "${responseKey}")`);
          });
        }
      } else {
        this.printOnNewline('get');
        this.withinBlock(() => {
          this.printOnNewline(`return snapshot["${responseKey}"]! as! ${typeName}`);
        });
        this.printOnNewline('set');
        this.withinBlock(() => {
          this.printOnNewline(`snapshot.updateValue(newValue, forKey: "${responseKey}")`);
        });
      }
    });
  }

  propertyDeclarationForTypeCondition(typeCondition: TypeCondition & Property & Struct) {
    const { propertyName, typeName, structName } = typeCondition;

    this.printNewlineIfNeeded();
    this.printOnNewline(`public var ${propertyName}: ${typeName}`);
    this.withinBlock(() => {
      this.printOnNewline('get');
      this.withinBlock(() => {
        this.printOnNewline(`if !${structName}.possibleTypes.contains(__typename) { return nil }`);
        this.printOnNewline(`return ${structName}(snapshot: snapshot)`);
      });
      this.printOnNewline('set');
      this.withinBlock(() => {
        this.printOnNewline(`guard let newValue = newValue else { return }`);
        this.printOnNewline(`snapshot = newValue.snapshot`);
      });
    });
  }

  initializerDeclarationForProperties(properties: Property[]) {
    this.printOnNewline(`public init`);
    this.parametersForProperties(properties);

    this.withinBlock(() => {
      properties.forEach(({ propertyName }) => {
        this.printOnNewline(`self.${propertyName} = ${propertyName}`);
      });
    });
  }

  parametersForProperties(properties: Property[]) {
    this.print('(');
    this.print(
      join(
        properties.map(({ propertyName, typeName, isOptional }) =>
          join([`${escapeIdentifierIfNeeded(propertyName)}: ${typeName}`, isOptional && ' = nil'])
        ),
        ', '
      )
    );
    this.print(')');
  }

  selectionSetInitialization(selectionSet: SelectionSet) {
    this.print('[');
    this.withIndent(() => {
      for (const selection of selectionSet.selections) {
        switch (selection.kind) {
          case 'Field': {
            const { name, alias, args, type } = selection;
            const responseKey = selection.alias || selection.name;
            const structName = this.helpers.structNameForPropertyName(responseKey);

            this.printOnNewline(`GraphQLField(`);
            this.print(
              join(
                [
                  `"${name}"`,
                  alias ? `alias: "${alias}"` : null,
                  args &&
                    args.length &&
                    `arguments: ${this.helpers.dictionaryLiteralForFieldArguments(args)}`,
                  `type: ${this.helpers.fieldTypeEnum(type, structName)}`
                ],
                ', '
              )
            );
            this.print('),');
            break;
          }
          case 'TypeCondition': {
            const structName = this.helpers.structNameForTypeCondition(selection.type);
            this.printOnNewline(`GraphQLFragmentSpread(${structName}.self),`);
            break;
          }
          case 'FragmentSpread': {
            const structName = this.helpers.structNameForFragmentName(selection.fragmentName);
            this.printOnNewline(`GraphQLFragmentSpread(${structName}.self),`);
            break;
          }
          case 'BooleanCondition':
            this.printOnNewline(`GraphQLBooleanCondition(`);
            this.print(
              join(
                [
                  `variableName: "${selection.variableName}"`,
                  `inverted: ${selection.inverted}`,
                  'selections: '
                ],
                ', '
              )
            );
            this.selectionSetInitialization(selection.selectionSet);
            this.print('),');
            break;
        }
      }
    });
    this.printOnNewline(']');
  }

  typeDeclarationForGraphQLType(type: GraphQLType) {
    if (type instanceof GraphQLEnumType) {
      this.enumerationDeclaration(type);
    } else if (type instanceof GraphQLInputObjectType) {
      this.structDeclarationForInputObjectType(type);
    }
  }

  enumerationDeclaration(type: GraphQLEnumType) {
    const { name, description } = type;
    const values = type.getValues();

    this.printNewlineIfNeeded();
    this.comment(description);
    this.printOnNewline(`public enum ${name}: String`);
    this.withinBlock(() => {
      values.forEach(value => {
        this.comment(value.description);
        this.printOnNewline(
          `case ${escapeIdentifierIfNeeded(this.helpers.enumCaseName(value.name))} = "${value.value}"`
        );
      });
    });
    this.printNewline();
    this.printOnNewline(`extension ${name}: Apollo.JSONDecodable, Apollo.JSONEncodable {}`);
  }

  structDeclarationForInputObjectType(type: GraphQLInputObjectType) {
    const { name: structName, description } = type;
    const adoptedProtocols = ['GraphQLMapConvertible'];
    const fields = Object.values(type.getFields());

    const properties = fields.map(this.helpers.propertyFromInputField, this.helpers);

    properties.forEach(property => {
      if (property.isOptional) {
        property.typeName = `Optional<${property.typeName}>`;
      }
    });

    this.structDeclaration({ structName, description, adoptedProtocols }, () => {
      this.printOnNewline(`public var graphQLMap: GraphQLMap`);

      this.printNewlineIfNeeded();
      this.printOnNewline(`public init`);
      this.print('(');
      this.print(
        join(
          properties.map(({ propertyName, typeName, isOptional }) =>
            join([`${propertyName}: ${typeName}`, isOptional && ' = nil'])
          ),
          ', '
        )
      );
      this.print(')');

      this.withinBlock(() => {
        this.printOnNewline(
          wrap(
            `graphQLMap = [`,
            join(properties.map(({ name, propertyName }) => `"${name}": ${propertyName}`), ', ') || ':',
            `]`
          )
        );
      });

      for (const { propertyName, typeName, description } of properties) {
        this.printNewlineIfNeeded();
        this.comment(description);
        this.printOnNewline(`public var ${propertyName}: ${typeName}`);
        this.withinBlock(() => {
          this.printOnNewline('get');
          this.withinBlock(() => {
            this.printOnNewline(`return graphQLMap["${propertyName}"] as! ${typeName}`);
          });
          this.printOnNewline('set');
          this.withinBlock(() => {
            this.printOnNewline(`graphQLMap.updateValue(newValue, forKey: "${propertyName}")`);
          });
        });
      }
    });
  }
}
