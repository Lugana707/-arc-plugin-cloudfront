const { toLogicalID } = require("@architect/utils");

/**
 * Architect serverless framework macro that creates a CloudFront distribution for an S3 bucket
 */
module.exports = {
  deploy: {
    start: ({ arc, cloudformation }) => {
      if (!arc.static) {
        console.warn("No static S3 bucket configured!");

        return cloudformation;
      }

      // Only run is @cloudfront-distribution is defined
      const cloudfront = arc["cloudfront-distribution"];
      if (!cloudfront) {
        console.warn(
          "No Cloudfront configuration available! Please add @cloudfront-distribution to your arc config file."
        );

        return cloudformation;
      }

      const {
        "page-default": pageDefault,
        "page-403": page403,
        "page-404": page404,
        bucket: bucketName = "Static"
      } = cloudfront.reduce(
        (accumulator, [key, value]) => ({ ...accumulator, [key]: value }),
        {}
      );

      // Resource names
      const bucket = {};
      bucket.ID = toLogicalID(bucketName);
      bucket.Name = `${bucket.ID}Bucket`;

      if (!cloudformation.Resources[bucket.Name]) {
        console.error("Cannot find bucket!", { bucketName, bucket, cloudformation });

        throw "Cannot find bucket!";
      }

      // https://github.com/aws-samples/amazon-cloudfront-secure-static-site/blob/master/templates/cloudfront-site.yaml

      // CloudFront Origin Access Identity
      const cloudFrontOriginAccessIdentity = {};
      cloudFrontOriginAccessIdentity.Name = `${bucket.ID}CloudFrontOriginAccessIdentity`;
      cloudFrontOriginAccessIdentity.sam = {
        Type: "AWS::CloudFront::CloudFrontOriginAccessIdentity",
        Properties: {
          CloudFrontOriginAccessIdentityConfig: {
            Comment: { "Fn::Sub": "CloudFront OAI for ${AWS::StackName}" }
          }
        }
      };

      // Response Headers Policy
      const responseHeadersPolicy = {};
      responseHeadersPolicy.Name = `${bucket.ID}ResponseHeadersPolicy`;
      responseHeadersPolicy.sam = {
        Type: "AWS::CloudFront::ResponseHeadersPolicy",
        Properties: {
          ResponseHeadersPolicyConfig: {
            Name: { "Fn::Sub": "${AWS::StackName}-static-site-security-headers" },
            SecurityHeadersConfig: {
              StrictTransportSecurity: {
                AccessControlMaxAgeSec: 63072000,
                IncludeSubdomains: true,
                Override: true,
                Preload: true
              },
              ContentSecurityPolicy: {
                ContentSecurityPolicy:
                  "default-src 'none'; img-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'",
                Override: true
              },
              ContentTypeOptions: {
                Override: true
              },
              FrameOptions: {
                FrameOption: "DENY",
                Override: true
              },
              ReferrerPolicy: { ReferrerPolicy: "same-origin", Override: true },
              XSSProtection: { ModeBlock: true, Override: true, Protection: true }
            }
          }
        }
      };

      // CloudFront Distribution
      const prependPathWithSlash = path => {
        if (path.startsWith("/")) {
          return path;
        }

        return `/${path}`;
      };

      const generateCustomErrorResponse = ({ path, code }) => {
        if (!path) {
          return null;
        }

        return {
          ErrorCachingMinTTL: 60,
          ErrorCode: code,
          ResponseCode: code,
          ResponsePagePath: prependPathWithSlash(path)
        };
      };

      const cloudFrontDistribution = {};
      cloudFrontDistribution.Name = `${bucket.ID}CloudFrontDistribution`;
      cloudFrontDistribution.sam = {
        Type: "AWS::CloudFront::Distribution",
        DependsOn: [bucket.Name],
        Properties: {
          DistributionConfig: {
            // Aliases: null,
            // Comment: "",
            CustomErrorResponses: [
              generateCustomErrorResponse({ path: page403, code: 403 }),
              generateCustomErrorResponse({ path: page404, code: 404 })
            ].filter(Boolean),
            // CustomOrigin: null,
            DefaultCacheBehavior: {
              Compress: true,
              DefaultTTL: 86400,
              ForwardedValues: {
                QueryString: true
              },
              MaxTTL: 31536000,
              TargetOriginId: { "Fn::Sub": "S3-${AWS::StackName}-root" },
              ViewerProtocolPolicy: "redirect-to-https",
              ResponseHeadersPolicyId: { Ref: responseHeadersPolicy.Name }
            },
            DefaultRootObject: prependPathWithSlash(pageDefault),
            Enabled: true,
            HttpVersion: "http2",
            IPV6Enabled: true,
            // Logging: null,
            Origins: [
              {
                DomainName: {
                  "Fn::GetAtt": [bucket.Name, "RegionalDomainName"]
                },
                Id: { "Fn::Sub": "S3-${AWS::StackName}-root" },
                S3OriginConfig: {
                  OriginAccessIdentity: {
                    "Fn::Join": [
                      "",
                      [
                        "origin-access-identity/cloudfront/",
                        { Ref: cloudFrontOriginAccessIdentity.Name }
                      ]
                    ]
                  }
                }
              }
            ],
            PriceClass: "PriceClass_All"
            // ViewerCertificate: null
          }
        }
      };

      if (
        cloudformation.Resources[cloudFrontDistribution.Name] ||
        cloudformation.Resources[responseHeadersPolicy.Name] ||
        cloudformation.Resources[cloudFrontOriginAccessIdentity.Name]
      ) {
        console.error(
          "Cannot create resources in CloudFormation - names already in use!",
          { cloudFrontDistribution, cloudFrontOriginAccessIdentity }
        );

        throw "Cannot create resources in CloudFormation - names already in use!";
      }

      cloudformation.Resources[cloudFrontDistribution.Name] = cloudFrontDistribution.sam;
      cloudformation.Resources[responseHeadersPolicy.Name] = responseHeadersPolicy.sam;
      cloudformation.Resources[cloudFrontOriginAccessIdentity.Name] =
        cloudFrontOriginAccessIdentity.sam;

      // Add outputs for new CloudFront Distribution
      cloudformation.Outputs[cloudFrontDistribution.Name] = {
        Description: "CloudFront Distribution URL",
        Value: {
          "Fn::GetAtt": `${cloudFrontDistribution.Name}.DomainName`
        }
      };

      return cloudformation;
    }
  }
};
