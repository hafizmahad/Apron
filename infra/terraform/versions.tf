terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State lives in S3 with native locking — `use_lockfile` writes a `.tflock` object
  # beside the state instead of needing a DynamoDB table. Terraform 1.10 introduced it,
  # and one environment does not need a second service to hold a lock.
  #
  # The bucket is created by `bootstrap/`, which keeps its own state locally because
  # something has to exist before a remote backend can.
  backend "s3" {
    bucket       = "apron-terraform-state-533267167718"
    key          = "apron/terraform.tfstate"
    region       = "us-east-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "apron"
      ManagedBy = "terraform"
    }
  }
}

# CloudFront certificates and WAF are global resources that must be addressed in
# us-east-1 regardless of where everything else lives. Apron uses CloudFront's own
# default certificate, so nothing needs this today — but a distribution that later
# takes a custom domain will, and having the alias already declared means adding a
# certificate is one resource rather than a provider refactor.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "apron"
      ManagedBy = "terraform"
    }
  }
}
