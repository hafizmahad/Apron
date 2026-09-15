# Apron infrastructure

Terraform for the single deployed environment: **AWS account `533267167718`, region
`us-east-2` (Ohio)**. The plan behind it, with the reasoning for each choice, is
`docs/INFRASTRUCTURE_PLAN.md`.

One environment (`CLAUDE.md` §3). Nothing is parameterised across environments that will
not exist. **No SES, and no email** (ADR-020) — the mail adapter runs `MAIL_TRANSPORT=log`
and notifications reach people through the notifications centre and the request timeline.

---

## What it builds

```
        https://d….cloudfront.net      ← the link you send someone
                    │
             CloudFront (TLS)
                    │  secret header, CloudFront prefix list only
              ALB (public subnets)     ← direct access answers 403
                    │  :3000
   ┌────────────────┴────────────────┐
   │    ECS Fargate, private subnets  │
   │  web ×2            worker ×1     │   one image, two entrypoints
   └──┬──────────────────────┬────────┘
      │                      │
  RDS Postgres 16      ElastiCache Redis 7      S3 documents
```

CloudFront is here for TLS, not for caching pages. `APP_ENV=production` issues the session
cookie `Secure`, and a browser will not store a `Secure` cookie over plain HTTP; an ALB
cannot hold a public certificate for its own `amazonaws.com` name. Without CloudFront the
site would load, accept a password, and bounce every user back to the login page with
nothing in the logs. Only `/_next/static/*` and `/assets/*` are cached — every portal page
is per-user and caching one would serve one operator's work to another.

---

## First run

Terraform ≥ 1.10 (S3 native state locking, no DynamoDB table). Credentials for the account
in a profile; these commands assume `AWS_PROFILE=apron`.

### 1. State bucket

```bash
cd infra/terraform/bootstrap
terraform init
terraform apply
```

Keeps its own state locally, because something must exist before a remote backend can
point at it.

### 2. Registries, then the first images

The services cannot start without an image, and the repositories do not exist until
Terraform makes them. So the registries are created first, on their own:

```bash
cd infra/terraform
terraform init
terraform apply -target='aws_ecr_repository.app'
```

Then build and push. `--provenance=false` because ECR rejects the attestation manifest
Buildx attaches by default, and `--platform linux/amd64` because the Fargate task is
x86 and a build on an ARM machine would otherwise produce an image it cannot run:

```bash
ACCOUNT=533267167718
REGION=us-east-2
TAG=$(git rev-parse --short HEAD)

aws ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com

for target in web worker; do
  docker build --platform linux/amd64 --provenance=false \
    --target $target \
    -t $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/apron/$target:$TAG .
  docker push $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/apron/$target:$TAG
done
```

### 3. Everything else

```bash
terraform apply -var="image_tag=$TAG"
```

RDS takes about ten minutes and CloudFront about the same; the first apply is not quick.

### 4. Migrations, then the seed

Both run as one-off tasks from the worker image. The seed is what creates the airports,
the service catalogue, the provider network and the first administrator — it is part of
deploying, not a local convenience.

```bash
CLUSTER=$(terraform output -raw ecs_cluster_name)
SUBNETS=$(terraform output -json private_subnet_ids | jq -r 'join(",")')
SG=$(terraform output -raw tasks_security_group_id)
NET="awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}"

run() {
  aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE \
    --task-definition apron-admin --network-configuration "$NET" \
    --overrides "{\"containerOverrides\":[{\"name\":\"admin\",\"command\":[\"node\",\"$1\"]}]}" \
    --query 'tasks[0].taskArn' --output text
}

run dist-worker/migrate.js
# wait for it to stop, check exit code 0, then:
run dist-worker/seed.js
```

Watch either in `/ecs/apron-tasks`. Both are idempotent: migrations are recorded with a
checksum and re-running applies nothing; every seed insert upserts on a natural key.

### 5. Verify against what was actually deployed

```bash
BASE=$(terraform output -raw app_url)
cd ../..
BASE=$BASE npm run smoke            # 15 checks
BASE=$BASE npm run verify:routing   # 340 checks
BASE=$BASE npm run verify:rbac      # 33 checks, cross-tenant denial from outside
```

A fix confirmed on one server proves nothing about another. This is the step that says the
deployment worked.

### 6. Hand the pipeline the role

```bash
terraform output -raw github_deploy_role_arn
```

Set it as the `AWS_DEPLOY_ROLE` repository variable in GitHub. No access key is created;
the role is assumed through OIDC and its trust policy names this repository and branch
only.

---

## Signing in

Every seeded account shares one password:

```bash
aws secretsmanager get-secret-value --secret-id apron/seed-password \
  --query SecretString --output text
```

Terraform generates it so that deployment is not blocked on a manual step. Replacing the
value in the console is expected and will not be reverted — the seed's guard refuses only
while the *published* development password is still in use.

The account list is `handover/Apron - Sign-in accounts.xlsx`; `admin@apron.local` opens
the Admin console, `ops.manager@apron.local` the Operations portal.

---

## Afterwards

**Enable AI.** Optional — the platform is fully usable with it off (Journey E). Put the key
in `apron/openai-api-key`, then `terraform apply -var="openai_api_key=…"` to flip
`AI_ENABLED` and attach the secret. Prefer passing it on the command line over writing a
tfvars file.

**Replace an asset.** `/assets/*` is cached at the edge:

```bash
aws cloudfront create-invalidation \
  --distribution-id $(terraform output -raw cloudfront_distribution_id) \
  --paths '/assets/*'
```

**Read the logs.** `/ecs/apron-web`, `/ecs/apron-worker`, `/ecs/apron-tasks`. JSON, one
object per line, every line carrying a correlation id.

---

## Deliberately absent

| | Why |
| --- | --- |
| SES, or any outbound mail | ADR-020. Notifications are still raised, recorded and shown; the channel is the product. |
| Multi-AZ RDS | Doubles the largest line on the bill for one environment. Seven days of backups and the restore in `docs/OPERATIONS.md` are the recovery story. |
| A second NAT gateway | Costs about what the database costs, to protect outbound traffic only. |
| Autoscaling policies | Two web tasks is the shape; a load that outgrows it is a decision, not a policy. |
| WAF | The whole surface behind the login is authorised server-side, and rate limiting is on in the application. |
| Route 53, ACM | No custom domain. CloudFront's own certificate. The `us_east_1` provider alias is already declared for when that changes. |
| DynamoDB lock table | Terraform 1.10 locks S3 state natively. |
| Anything reading token counts or model cost | ADR-015. |

## Destroying

`aws_db_instance.main` has `deletion_protection`, the ALB has
`enable_deletion_protection`, and the state bucket has `prevent_destroy`. All three are
intentional and all three have to be turned off by hand before a `terraform destroy` will
proceed. That is the point of them.
