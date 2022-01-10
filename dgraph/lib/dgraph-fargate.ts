import * as cdk from "aws-cdk-lib";
import { Construct } from 'constructs';
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecsp from "aws-cdk-lib/aws-ecs-patterns";

interface DGraphContainerProps {
    containerName: string;
    taskDefinition?: ecs.TaskDefinition;
    logging: ecs.AwsLogDriver;
    command: string;
    ports: number[]
    sourceVolume?: string;
    essential?: boolean;
    image?: string
}

interface DGraphTargetRegistrationProps {
    fargate: ecsp.ApplicationLoadBalancedFargateService,
    containerName: string,
    targetProps: ecsp.ApplicationTargetProps,
    port?: number
}

interface VolumeDefinition {
    name: string;
    removalPolicy: cdk.RemovalPolicy;
    efsVolumeConfiguration: {
        fileSystemId: string;
        transitEncryption: string;
        authorizationConfig: {
            accessPointId: string;
        };
    };
}

const DGraphVolumeName = 'efs-data';

export class DgraphStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);
        const vpc = createVpc(this);
        const cluster = createCluster(this, vpc);
        const fileSystem = createFileSystem(this, vpc);
        const executionRole = createTaskExecutionRole(this);
        const taskRole = createTaskRole(this);
        const logging = new ecs.AwsLogDriver({ streamPrefix: "dgraph" })
        const volume = createVolumeProps(this, fileSystem, DGraphVolumeName)

        const taskDefinition = createDGraphTaskDefinition(this, executionRole, taskRole, volume,
            [{
                containerName: "DGraphAlphaContainer",
                essential: true,
                logging,
                command: "/bin/sh -c \"dgraph alpha --my=localhost:7080 --zero=localhost:5080\"",
                ports: [8080, 9080],
                sourceVolume: DGraphVolumeName
            },
            {
                containerName: "DGraphZeroContainer",
                logging,
                command: "/bin/sh -c \"dgraph zero --my=localhost:5080\"",
                ports: [5080, 6080],
                sourceVolume: DGraphVolumeName
            },
            {
                containerName: "DGraphRatelContainer",
                logging,
                command: "/bin/sh -c \"dgraph-ratel\"",
                image: "dgraph/ratel:latest",
                ports: [8000]
            }]);

        const fargate = createService(this, cluster, taskDefinition, fileSystem)

        const listener = fargate.loadBalancer.addListener(
            "DGraphRatelListener",
            {
                port: 8000,
                protocol: elbv2.ApplicationProtocol.HTTP,
                open: true
            }
        )

        const target = fargate.service.loadBalancerTarget(
            {
                containerName: "DGraphRatelContainer",
                containerPort: 8000,
                protocol: ecs.Protocol.TCP
            }
        )

        listener.addTargets(
            "DGraphRatelTargetGroup",
            {
                protocol: elbv2.ApplicationProtocol.HTTP,
                targets: [target]
            },
        )


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
        removalPolicy: cdk.RemovalPolicy.DESTROY,
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

function createDGraphContainer(stack: cdk.Stack, containerProps: DGraphContainerProps) {
    const { containerName, taskDefinition, logging, command, ports, sourceVolume, essential, image = "dgraph/dgraph:latest" } = containerProps;
    const container = new ecs.ContainerDefinition(stack, containerName, {
        containerName,
        taskDefinition: taskDefinition!,
        essential,
        logging,
        image: ecs.ContainerImage.fromRegistry(image),
        cpu: 4,
        entryPoint: ["sh", "-c"],
        command: [command],
        portMappings: ports.map(x => ({
            hostPort: x,
            containerPort: x,
            protocol: ecs.Protocol.TCP
        }))
    });

    if (sourceVolume) {
        container.addMountPoints({
            sourceVolume,
            containerPath: '/dgraph',
            readOnly: false
        });
    }

    return container;
}

function createDGraphTaskDefinition(
    stack: cdk.Stack,
    executionRole: iam.Role,
    taskRole: iam.Role,
    volume: VolumeDefinition,
    containers: DGraphContainerProps[]
) {

    const taskDefinition = new ecs.FargateTaskDefinition(
        stack,
        "DGraphTaskDefinition",
        {
            cpu: 512,
            memoryLimitMiB: 2048,
            executionRole,
            taskRole,
            volumes: [volume]
        }
    );

    containers.forEach(container => createDGraphContainer(stack, { ...container, taskDefinition }));

    return taskDefinition;
}

function createVolumeProps(stack: cdk.Stack, fileSystem: efs.FileSystem, name: string) {
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
        removalPolicy: cdk.RemovalPolicy.DESTROY,
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

function registerECSTarget(targetRegistrationProps: DGraphTargetRegistrationProps): elbv2.ApplicationTargetGroup {
    const conditions: Array<elbv2.ListenerCondition> = [];
    const { fargate, containerName, targetProps, port } = targetRegistrationProps

    if (targetProps.hostHeader) {
        conditions.push(elbv2.ListenerCondition.hostHeaders([targetProps.hostHeader]));
    }
    if (targetProps.pathPattern) {
        conditions.push(elbv2.ListenerCondition.pathPatterns([targetProps.pathPattern]));
    }
    const targetGroup = fargate.listener.addTargets(`ECSTargetGroup${containerName}${targetProps.containerPort}`, {
        port: port || 80,
        targets: [
            fargate.service.loadBalancerTarget({
                containerName: containerName,
                containerPort: targetProps.containerPort,
                protocol: targetProps.protocol || ecs.Protocol.TCP,
            }),
        ],
        conditions,
        priority: targetProps.priority,
    });

    return targetGroup;
}

function createService(
    stack: cdk.Stack,
    cluster: ecs.Cluster,
    taskDefinition: ecs.TaskDefinition,
    fileSystem: efs.FileSystem
) {
    const serviceName = `${stack.stackName}-service`;

    const fargate = new ecsp.ApplicationLoadBalancedFargateService(
        stack,
        "DGraphFargateService",
        {
            cluster,
            serviceName,
            cpu: 256,
            desiredCount: 1,
            taskDefinition,
            memoryLimitMiB: 512,
            assignPublicIp: true
        }
    );

    // Need to add permissions to and from the file system to the target,
    // or else the task will timeout trying to mount the file system.
    fargate.service.connections.allowFrom(fileSystem, ec2.Port.tcp(efs.FileSystem.DEFAULT_PORT));
    fargate.service.connections.allowTo(fileSystem, ec2.Port.tcp(efs.FileSystem.DEFAULT_PORT));

    enableExecuteCommand(fargate);

    return fargate;
}

function enableExecuteCommand<T extends Construct>(service: T) {
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