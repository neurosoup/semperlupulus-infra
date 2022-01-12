import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";

export class UserPoolStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // User Pool
    const userPool = new cognito.UserPool(this, "SemperLupulusUserPool", {
      userPoolName: "SemperLupulusUserPool",
      selfSignUpEnabled: true,
      userInvitation: {
        emailSubject: "Votre mot de passe temporaire SemperLupulus.",
        emailBody:
          "Merci pour votre inscription ! Votre code de vérification est {####}",
      },
      userVerification: {
        emailSubject:
          "Vérification de l'email d'inscription sur l'application SemperLupulus",
        emailBody:
          "Merci pour votre inscription ! Votre code de vérification est {####}",
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      standardAttributes: {
        givenName: {
          required: true,
          mutable: true,
        },
        familyName: {
          required: true,
          mutable: true,
        },
      },
      customAttributes: {
        isAdmin: new cognito.StringAttribute({ mutable: true }),
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: true,
        requireUppercase: false,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolClient = userPool.addClient("userPoolClientId", {
      userPoolClientName: "SemperLupulus",
    });

    // const cfnUserPool = userPool.node.defaultChild as cognito.CfnUserPool;
    // cfnUserPool.emailConfiguration = {
    //   emailSendingAccount: "DEVELOPER",
    //   replyToEmailAddress: "no-reply@semperlupulus.com",
    //   sourceArn: `arn:aws:ses:YOUR_COGNITO_SES_REGION:${
    //     cdk.Stack.of(this).account
    //   }:identity/YOUR_EMAIL@example.com`,
    // };

    new cdk.CfnOutput(this, "userPoolId", {
      value: userPool.userPoolId,
    });
    new cdk.CfnOutput(this, "userPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });
  }
}
