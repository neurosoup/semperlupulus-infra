import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as logs from 'aws-cdk-lib/aws-logs';
import { CfnService } from 'aws-cdk-lib/aws-ecs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { Bucket } from 'aws-cdk-lib/aws-s3';

export class DgraphStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "DGraphVpc", {
      maxAzs: 2 // Default is all AZs in region
    });

    // create kms key
    const kmsKey = new kms.Key(this, 'KmsKey');
    // create log group
    const logGroup = new logs.LogGroup(this, 'LogGroup');
    // ecs exec bucket
    const execBucket = new Bucket(this, 'EcsExecBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const cluster = new ecs.Cluster(this, "DGraphAutoScalingCluster", {
      vpc: vpc,
      executeCommandConfiguration: {
        kmsKey,
        logConfiguration: {
          cloudWatchLogGroup: logGroup,
          s3Bucket: execBucket,
          s3KeyPrefix: 'exec-output'
        },
        logging: ecs.ExecuteCommandLogging.OVERRIDE
      }
    });
    cluster.addCapacity('DefaultAutoScalingGroup', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
    });

    // create a task definition with CloudWatch Logs
    const logging = new ecs.AwsLogDriver({ streamPrefix: "dgraph" })

    const executionRole = new iam.Role(this, 'TaskExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    executionRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'));

    const taskRole = new iam.Role(this, "MaintenanceRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      inlinePolicies: {
        ecsExec: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "ssmmessages:CreateControlChannel",
                "ssmmessages:CreateDataChannel",
                "ssmmessages:OpenControlChannel",
                "ssmmessages:OpenDataChannel",
              ],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    // Create a task definition with its own elastic network interface
    const taskDefinition = new ecs.Ec2TaskDefinition(this, 'dgraph-awspvc', {
      networkMode: ecs.NetworkMode.AWS_VPC,
      executionRole,
      taskRole
    });
    const dgraphContainer = taskDefinition.addContainer('dgraph', {
      image: ecs.ContainerImage.fromRegistry("dgraph/dgraph"),
      cpu: 256,
      memoryLimitMiB: 512,
      essential: true,
      logging,
      // entryPoint: ["sh", "-c"],
      // command: [
      //   "/bin/sh -c \"echo '<html> <head> <title>Amazon ECS Sample App</title> <style>body {margin-top: 40px; background-color: #333;} </style> </head><body> <div style=color:white;text-align:center> <h1>Amazon ECS Sample App</h1> <h2>Congratulations!</h2> <p>Your application is now running on a container in Amazon ECS.</p> </div></body></html>' >  /usr/local/apache2/htdocs/index.html && httpd-foreground\"",
      // ],
    });
    dgraphContainer.addPortMappings({
      containerPort: 8080,
      hostPort: 8080,
      protocol: ecs.Protocol.TCP,
    });

    // Create a security group that allows HTTP traffic on port 8080 for our containers without modifying the security group on the instance
    const securityGroup = new ec2.SecurityGroup(this, 'dgraph-queries', {
      vpc,
      allowAllOutbound: false,
    });
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080));

    // Create the service
    const ecsService = new ecs.Ec2Service(this, 'dgraph-service', {
      cluster,
      taskDefinition,
      securityGroups: [securityGroup],
      enableExecuteCommand: true
    });


    logGroup.grantWrite(taskDefinition.taskRole);
    kmsKey.grantDecrypt(taskDefinition.taskRole);
    execBucket.grantPut(taskDefinition.taskRole);

    new CfnOutput(this, 'EcsGetTask', {
      value: `aws ecs list-tasks --service-name ${ecsService.serviceName} --cluster ${cluster.clusterName} --query "taskArns[0]" --output text`
    });

    new CfnOutput(this, "ExecTaskCommand", {
      value: `aws ecs execute-command --cluster  ${cluster.clusterName} --task [result of EcsGetTask] --container ${taskDefinition.defaultContainer?.containerName} --command "/bin/bash" --interactive`
    })
  }
}
