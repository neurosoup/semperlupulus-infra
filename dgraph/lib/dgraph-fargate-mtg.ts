import * as cdk from "aws-cdk-lib";
import { Construct } from 'constructs';
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as efs from 'aws-cdk-lib/aws-efs';
import * as ecsp from "aws-cdk-lib/aws-ecs-patterns";
import { AddApplicationTargetsProps, ApplicationLoadBalancer, ApplicationProtocol, ApplicationTargetGroup, ApplicationTargetGroupProps, IpAddressType, TargetType } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { ApplicationLoadBalancerProps, ApplicationMultipleTargetGroupsFargateService } from "aws-cdk-lib/aws-ecs-patterns";
import { LoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancing";

export class DgraphStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);
        const vpc = createVpc(this);
        const cluster = createCluster(this, vpc);
        const fileSystem = createFileSystem(this, vpc);
        const executionRole = createTaskExecutionRole(this);
        const taskRole = createTaskRole(this);
        const taskDefinition = createTaskDefinition(this, executionRole, taskRole, fileSystem);
        createService(this, cluster, taskDefinition, fileSystem, vpc);
    }
}

function createVpc(stack: cdk.Stack) {
    return new ec2.Vpc(stack, `DGraphVpc`, {
        natGateways: 0,
        cidr: "10.0.0.0/16",
        maxAzs: 2,
        subnetConfiguration: [
            {
                cidrMask: 24,
                name: "dgraph",
                subnetType: ec2.SubnetType.PUBLIC,
            },
        ],
    });
}

function createFileSystem(stack: cdk.Stack, vpc: ec2.Vpc) {
    const fileSystem = new efs.FileSystem(stack, 'DgraphEfsFileSystem', {
        vpc: vpc,
        encrypted: false,
        lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
        performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
        throughputMode: efs.ThroughputMode.BURSTING,
        fileSystemName: "DGraphFilesystem",
    });
    return fileSystem;
}

function createCluster(stack: cdk.Stack, vpc: ec2.Vpc) {
    const cluster = new ecs.Cluster(stack, "DGraphCluster", {
        vpc,
        clusterName: `${stack.stackName}-cluster`,
    });
    return cluster;
}

function createTaskExecutionRole(stack: cdk.Stack): iam.Role {
    const role = new iam.Role(stack, "EcsTaskExecutionRole", {
        roleName: "EcsTaskExecutionRole",
        assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        managedPolicies: [
            iam.ManagedPolicy.fromAwsManagedPolicyName(
                "service-role/AmazonECSTaskExecutionRolePolicy"
            ),
            iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMReadOnlyAccess"),
        ],
    });
    return role;
}

function createTaskRole(stack: cdk.Stack): iam.Role {
    const role = new iam.Role(stack, "TaskRole", {
        assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    role.addToPrincipalPolicy(
        new iam.PolicyStatement({
            actions: [
                "ssmmessages:CreateControlChannel",
                "ssmmessages:CreateDataChannel",
                "ssmmessages:OpenControlChannel",
                "ssmmessages:OpenDataChannel",
            ],
            resources: ["*"],
        })
    );

    return role;
}

function createTaskDefinition(
    stack: cdk.Stack,
    executionRole: iam.Role,
    taskRole: iam.Role,
    fileSystem: efs.FileSystem
) {
    const logging = new ecs.AwsLogDriver({ streamPrefix: "dgraph" })

    const volume = createVolume(stack, fileSystem, 'efs-data')

    const taskDefinition = new ecs.FargateTaskDefinition(
        stack,
        "DGraphZeroTaskDefinition",
        {
            cpu: 512,
            memoryLimitMiB: 2048,
            executionRole,
            taskRole,
            volumes: [volume]
        }
    );

    const zero = new ecs.ContainerDefinition(stack, "DGraphZeroContainer", {
        containerName: "DgraphZeroContainer",
        taskDefinition,
        logging,
        image: ecs.ContainerImage.fromRegistry("dgraph/dgraph:latest"),
        cpu: 4,
        entryPoint: ["sh", "-c"],
        command: [
            "/bin/sh -c \"dgraph zero --my=localhost:5080\"",
        ],
        portMappings: [
            {
                hostPort: 5080,
                containerPort: 5080,
                protocol: ecs.Protocol.TCP,
            },
            {
                hostPort: 6080,
                containerPort: 6080,
                protocol: ecs.Protocol.TCP,
            },
        ],
    });


    const alpha = new ecs.ContainerDefinition(stack, "DGraphAlphaContainer", {
        containerName: "DgraphAlphaContainer",
        taskDefinition,
        logging,
        image: ecs.ContainerImage.fromRegistry("dgraph/dgraph:latest"),
        cpu: 4,
        entryPoint: ["sh", "-c"],
        command: [
            "/bin/sh -c \"dgraph alpha --my=localhost:7080 --zero=localhost:5080\"",
        ],
        portMappings: [
            {
                hostPort: 8080,
                containerPort: 8080,
                protocol: ecs.Protocol.TCP,
            },
            {
                hostPort: 9080,
                containerPort: 9080,
                protocol: ecs.Protocol.TCP,
            },
        ],
    });

    zero.addMountPoints({
        sourceVolume: volume.name,
        containerPath: '/dgraph',
        readOnly: false
    });

    alpha.addMountPoints({
        sourceVolume: volume.name,
        containerPath: '/dgraph',
        readOnly: false
    });

    return taskDefinition;
}

function createVolume(stack: cdk.Stack, fileSystem: efs.FileSystem, name: string) {
    const accessPoint = new efs.AccessPoint(stack, "AccessPoint", {
        fileSystem: fileSystem,
        path: "/tmp/data",
        createAcl: {
            ownerUid: "1000",
            ownerGid: "1000",
            permissions: "0755",
        },
        posixUser: {
            uid: "1000",
            gid: "1000",
        },
    });

    const volume = {
        name,
        efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
            transitEncryption: "ENABLED",
            authorizationConfig: {
                accessPointId: accessPoint.accessPointId,
            },
        }
    }

    return volume
}

function createService(
    stack: cdk.Stack,
    cluster: ecs.Cluster,
    taskDefinition: ecs.TaskDefinition,
    fileSystem: efs.FileSystem,
    vpc: ec2.Vpc
) {
    const serviceName = `${stack.stackName}-service`;

    const loadBalancer: ApplicationLoadBalancerProps = {
        name: 'DGraphLoadBalancer',
        publicLoadBalancer: true,
        listeners: [{
            name: 'DataListener',
            port: 80,
        }]
    }

    const targetGroup: ApplicationTargetGroupProps = {
        targetGroupName: "DGraphTarget",
        vpc,
        port: 8080,
        protocol: ApplicationProtocol.HTTP,

    }

    // Create ALB
    const lb = new ApplicationLoadBalancer(stack, 'DGraphLoadBalancer', {
        vpc,
        internetFacing: true,
        ipAddressType: IpAddressType.IPV4,
        vpcSubnets: vpc.selectSubnets({
            subnetType: ec2.SubnetType.PUBLIC,
        })
    });
    const listener = lb.addListener('DGraphPublicListener', { port: 80, open: true });

    const fargateService = new ecsp.ApplicationMultipleTargetGroupsFargateService(

        stack,
        "DGraphFargateService",
        {
            cluster,
            serviceName,
            cpu: 256,
            desiredCount: 1,
            taskDefinition,
            memoryLimitMiB: 512,
            assignPublicIp: true,

        }
    );
    enableExecuteCommand(fargateService);


    fargateService.listener.addTargets('alpha', {
        port: 8080,
        targets: [
            fargateService.service.loadBalancerTarget({
                containerName: 'DgraphAlphaContainer',
                containerPort: 8080
            })]

    })



    // Need to add permissions to and from the file system to the target,
    // or else the task will timeout trying to mount the file system.
    fargateService.service.connections.allowFrom(fileSystem, ec2.Port.tcp(efs.FileSystem.DEFAULT_PORT));
    fargateService.service.connections.allowTo(fileSystem, ec2.Port.tcp(efs.FileSystem.DEFAULT_PORT));

    return fargateService;
}

function enableExecuteCommand(
    service: ecsp.ApplicationMultipleTargetGroupsFargateService
) {
    service.node.children.filter(isFargateService).forEach((fargateService) => {
        fargateService.node.children.filter(isCfnService).forEach((cfnService) => {
            cfnService.addOverride("Properties.EnableExecuteCommand", true);
        });
    });
}

function isFargateService(cdkChild: any): cdkChild is ecs.FargateService {
    return cdkChild instanceof ecs.FargateService;
}

function isCfnService(cdkChild: any): cdkChild is ecs.CfnService {
    return cdkChild instanceof ecs.CfnService;
}