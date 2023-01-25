import {RemovalPolicy} from "aws-cdk-lib";
import {Construct} from "constructs";
import * as sf from "aws-cdk-lib/aws-stepfunctions";
import * as stepfunctions from "aws-cdk-lib/aws-stepfunctions";
import {JsonPath, LogLevel} from "aws-cdk-lib/aws-stepfunctions";
import * as logs from 'aws-cdk-lib/aws-logs';
import {CallAwsService} from 'aws-cdk-lib/aws-stepfunctions-tasks';

import {Effect, PolicyDocument, PolicyStatement, Role, ServicePrincipal} from "aws-cdk-lib/aws-iam";
import {AttributeType, BillingMode, ITable, Table} from "aws-cdk-lib/aws-dynamodb";
import {AccountRecovery, IUserPool, UserPool} from "aws-cdk-lib/aws-cognito";


export class SampleStateMachine extends Construct {
    private readonly _stateMachine: sf.StateMachine;

    constructor(scope: Construct, id: string) {
        super(scope, id);

        const userPool = new UserPool(this, 'SampleUserPool', {
            userPoolName: 'SamplePool',
            signInAliases: {
                email: true,
                username:true,
                preferredUsername:true
            },
            autoVerify: {
                email: false,
            },
            standardAttributes: {
                email: {
                    required: true,
                    mutable: true,
                }
            },
            passwordPolicy: {
                minLength: 12,
                requireLowercase: true,
                requireDigits: true,
                requireUppercase: true,
                requireSymbols: true,
            },
            accountRecovery: AccountRecovery.EMAIL_ONLY,
            removalPolicy: RemovalPolicy.RETAIN,
        });

        const table = new Table(this, id, {
            billingMode: BillingMode.PAY_PER_REQUEST,
            removalPolicy: RemovalPolicy.RETAIN,
            partitionKey: { name: 'PK', type: AttributeType.STRING },
            sortKey: { name: 'SK', type: AttributeType.STRING },
            pointInTimeRecovery: true,
            tableName: 'SampleUsers',
        });



        const logGroup = new logs.LogGroup(this, 'CloudwatchLogs', {
            logGroupName: '/aws/vendedlogs/states/sample-logs'
        });

        const userPoolAdmin = new PolicyDocument({
            statements: [
                new PolicyStatement({
                    resources: [userPool.userPoolArn],
                    effect: Effect.ALLOW,
                    actions: ['cognito-idp:AdminCreateUser'],
                }),
            ],

        });


        const role = new Role(this, 'StateMachineUserPoolRole', {
            assumedBy: new ServicePrincipal(`states.us-west-2.amazonaws.com`),
            inlinePolicies: {
                userPoolAdmin: userPoolAdmin,
            },
        });

        const flow = this.buildStateMachine(scope, table, userPool);

        this._stateMachine = new stepfunctions.StateMachine(this, 'StateMachine', {
            role: role,
            stateMachineName: 'UserCreation',
            definition: flow,
            stateMachineType: stepfunctions.StateMachineType.EXPRESS,
            logs: {
                level: LogLevel.ALL,
                destination: logGroup,
                includeExecutionData: true
            }
        });

        table.grantReadWriteData(this._stateMachine);
    }

    buildStateMachine = (scope: Construct, t: ITable, u: IUserPool): stepfunctions.IChainable => {
        const pass = new stepfunctions.Pass(scope, 'Pass');
        const fail = new stepfunctions.Fail(scope, 'Fail');
        let rollbackUser = this.buildRollbackUser(t);
        let createCognitoUser = this.buildCreateCognitoUser(u)
        let correctLastId = this.buildCorrectLastId(t);
        let createDbUser = this.buildCreateDynamoDBUser(t);
        let findLastId = this.buildFindLastId(t);


        createCognitoUser.addCatch(rollbackUser, {
            errors: [
                "CognitoIdentityProvider.UsernameExistsException"
            ],
            resultPath: "$.error"
        })

        createDbUser.addCatch(correctLastId, {
            errors: [
                "DynamoDB.ConditionalCheckFailedException",
                "DynamoDb.TransactionCanceledException"
            ],
            resultPath: "$.error"
        })

        correctLastId.next(findLastId);
        rollbackUser.next(fail);

        return findLastId
            .next(createDbUser)
            .next(createCognitoUser)
            .next(pass);
    }

    buildCreateCognitoUser = (u: IUserPool): CallAwsService => {
        return new CallAwsService(this, 'CreateCognitoUser', {
            action: "adminCreateUser",
            iamResources: [u.userPoolArn],
            parameters: {
                "UserPoolId": u.userPoolId,
                "Username.$": "$.context.userId",
                "UserAttributes": [
                    {
                        "Name": "email",
                        "Value.$": "$.emailAddress"
                    },
                    {
                        "Name": "email_verified",
                        "Value": "true"
                    }
                ]
            },
            service: "cognitoidentityprovider",
        });
    }

    buildRollbackUser = (t: ITable): CallAwsService => {
        return new CallAwsService(this, 'RollbackUser', {
            action: "deleteItem",
            iamResources: [t.tableArn],
            parameters: {
                "TableName": t.tableName,
                "Key": {
                    "PK": {
                        "S.$": "States.Format('USERPROFILE#{}', $.context.userId)"
                    },
                    "SK": {
                        "S.$": "States.Format('USERPROFILE#{}', $.context.userId)"
                    }
                }
            },

            resultPath: "$.results",
            service: "dynamodb",
        });
    }

    buildCorrectLastId = (t: ITable): CallAwsService => {
        return new CallAwsService(this, 'CorrectLastId', {
            action: "updateItem",
            iamResources: [t.tableArn],
            parameters: {
                "TableName": t.tableName,
                "ConditionExpression": "LastId = :previousUserId",
                "UpdateExpression": "SET LastId = :newUserId",
                "ExpressionAttributeValues": {
                    ":previousUserId": {
                        "N.$": "$.context.previousUserId"
                    },
                    ":newUserId": {
                        "N.$": "$.context.userId"
                    }
                },
                "Key": {
                    "PK": {
                        "S": "USERMETADATA"
                    },
                    "SK": {
                        "S": "USERMETADATA"
                    }
                }
            },

            resultPath: "$.results",
            service: "dynamodb",
        });
    }

    buildCreateDynamoDBUser = (t: ITable): CallAwsService => {
        return new CallAwsService(this, 'CreateDynamoDBUser', {
            action: "transactWriteItems",
            iamResources: [t.tableArn],
            parameters: {
                "TransactItems": [
                    {
                        "Put": {
                            "Item": {
                                PK: {
                                    "S.$": "States.Format('USERPROFILE#{}', $.context.userId)"
                                },
                                SK: {
                                    "S.$": "States.Format('USERPROFILE#{}', $.context.userId)"
                                },
                                FirstName: {
                                    "S.$": "$.firstName"
                                },
                                LastName: {
                                    "S.$": "$.lastName"
                                },
                                EmailAddress: {
                                    "S.$": "$.emailAddress"
                                },
                                PhoneNumber: {
                                    "S.$": "$.phoneNumber"
                                }
                            },
                            "ConditionExpression": "attribute_not_exists(PK)",
                            "TableName": t.tableName
                        }
                    },
                    {
                        "Update": {
                            "ConditionExpression": "LastId = :previousUserId",
                            "UpdateExpression": "SET LastId = :newUserId",
                            "ExpressionAttributeValues": {
                                ":previousUserId": {
                                    "N.$": "$.context.previousUserId"
                                },
                                ":newUserId": {
                                    "N.$": "$.context.userId"
                                }
                            },
                            "Key": {
                                "PK": {
                                    "S": "USERMETADATA"
                                },
                                "SK": {
                                    "S": "USERMETADATA"
                                }
                            },
                            "TableName": t.tableName
                        }
                    }
                ]
            },
            service: "dynamodb",
            resultPath: JsonPath.DISCARD,

        });
    }

    buildFindLastId = (t: ITable): CallAwsService => {
        return new CallAwsService(this, 'FindLastId', {
            action: "getItem",
            iamResources: [t.tableArn],
            parameters: {
                TableName: t.tableName,
                ConsistentRead: true,
                Key: {
                    PK: {
                        S: "USERMETADATA"
                    },
                    SK: {
                        S: "USERMETADATA"
                    }
                }
            },
            service: "dynamodb",
            resultSelector: {
                "previousUserId.$": "$.Item.LastId.N",
                "userId.$": "States.Format('{}', States.MathAdd(States.StringToJson($.Item.LastId.N), 1))"
            },
            resultPath: "$.context"
        });
    }

}