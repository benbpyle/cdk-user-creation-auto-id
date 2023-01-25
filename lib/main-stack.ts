import {Construct} from 'constructs';
import * as cdk from 'aws-cdk-lib';
import {SampleStateMachine} from "./state-machine-stack";

interface LambdaStackProps extends cdk.StackProps {
}

export class MainStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: LambdaStackProps) {
        super(scope, id, props);

        new SampleStateMachine(this, 'StateMachineConstruct')
    }
}
