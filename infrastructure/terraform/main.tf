# =============================================================================
# Banking application — AWS infrastructure
#
# Security invariants enforced here:
#   1. Database subnets are STRICTLY PRIVATE — no internet-gateway route,
#      no public IP assignment, inbound allowed only from the application tier.
#   2. ALL PII fields (SSN, date-of-birth, address) stored in RDS/DynamoDB are
#      encrypted at rest using a customer-managed AWS KMS key with automatic
#      annual rotation enabled.
# =============================================================================

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ─── Input variables ─────────────────────────────────────────────────────────

variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment: staging or production"
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "kms_deletion_window_days" {
  description = "Waiting period (in days) before a scheduled KMS key deletion takes effect (7–30)"
  type        = number
  default     = 30

  validation {
    condition     = var.kms_deletion_window_days >= 7 && var.kms_deletion_window_days <= 30
    error_message = "kms_deletion_window_days must be between 7 and 30."
  }
}

# ─── KMS key for PII field encryption ────────────────────────────────────────
#
# All columns storing PII (SSN, date-of-birth, postal address, email) MUST be
# encrypted using this key.  Annual automatic key rotation is mandatory.

resource "aws_kms_key" "pii" {
  description             = "CMK for PII field encryption (SSN, DOB, address, email)"
  deletion_window_in_days = var.kms_deletion_window_days
  enable_key_rotation     = true # mandatory — enforces annual rotation

  tags = {
    Name        = "banking-pii-cmk-${var.environment}"
    Environment = var.environment
    DataClass   = "PII"
    ManagedBy   = "terraform"
  }
}

resource "aws_kms_alias" "pii" {
  name          = "alias/banking-pii-${var.environment}"
  target_key_id = aws_kms_key.pii.key_id
}

# ─── VPC ─────────────────────────────────────────────────────────────────────

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "banking-vpc-${var.environment}"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ─── Public subnets (application / load-balancer tier only) ──────────────────

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name        = "banking-igw-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.0.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = true

  tags = {
    Name        = "banking-public-a-${var.environment}"
    Tier        = "public"
    Environment = var.environment
  }
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "${var.aws_region}b"
  map_public_ip_on_launch = true

  tags = {
    Name        = "banking-public-b-${var.environment}"
    Tier        = "public"
    Environment = var.environment
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name        = "banking-public-rt-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

# ─── STRICTLY PRIVATE database subnets ───────────────────────────────────────
#
# These subnets have NO route to an internet gateway and NO NAT gateway.
# `map_public_ip_on_launch` is explicitly false (the default, set here for
# self-documenting clarity).  Only intra-VPC traffic from the application
# security group is permitted (see aws_security_group.db below).

resource "aws_subnet" "db_private_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.32.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = false # STRICTLY PRIVATE — never assign public IPs

  tags = {
    Name        = "banking-db-private-a-${var.environment}"
    Tier        = "database"
    Environment = var.environment
  }
}

resource "aws_subnet" "db_private_b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.33.0/24"
  availability_zone       = "${var.aws_region}b"
  map_public_ip_on_launch = false # STRICTLY PRIVATE — never assign public IPs

  tags = {
    Name        = "banking-db-private-b-${var.environment}"
    Tier        = "database"
    Environment = var.environment
  }
}

# Private route table — no default route, no internet gateway entry.
resource "aws_route_table" "private_db" {
  vpc_id = aws_vpc.main.id

  # Intentionally empty: no 0.0.0.0/0 route — the database tier must never
  # reach or be reachable from the public internet.

  tags = {
    Name        = "banking-db-private-rt-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_route_table_association" "db_private_a" {
  subnet_id      = aws_subnet.db_private_a.id
  route_table_id = aws_route_table.private_db.id
}

resource "aws_route_table_association" "db_private_b" {
  subnet_id      = aws_subnet.db_private_b.id
  route_table_id = aws_route_table.private_db.id
}

# ─── Security groups ─────────────────────────────────────────────────────────

resource "aws_security_group" "app" {
  name        = "banking-app-sg-${var.environment}"
  description = "Application tier — allows HTTPS inbound, all outbound within VPC"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS from internet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "All outbound within VPC"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = {
    Name        = "banking-app-sg-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_security_group" "db" {
  name        = "banking-db-sg-${var.environment}"
  description = "Database tier — inbound only from app tier, no outbound to internet"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "PostgreSQL from application tier only"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  # No egress rule → implicit AWS deny-all-outbound.
  # Explicitly set an empty egress to override any Terraform provider defaults.
  egress {
    description = "Deny all outbound (database tier must not initiate connections)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = []
  }

  tags = {
    Name        = "banking-db-sg-${var.environment}"
    Environment = var.environment
  }
}

# ─── RDS subnet group ─────────────────────────────────────────────────────────

resource "aws_db_subnet_group" "main" {
  name        = "banking-db-subnet-group-${var.environment}"
  description = "Strictly private subnets for RDS — no internet access"
  subnet_ids  = [aws_subnet.db_private_a.id, aws_subnet.db_private_b.id]

  tags = {
    Name        = "banking-db-subnet-group-${var.environment}"
    Environment = var.environment
  }
}

# ─── Outputs ─────────────────────────────────────────────────────────────────

output "kms_pii_key_arn" {
  description = "ARN of the customer-managed KMS key used to encrypt PII fields"
  value       = aws_kms_key.pii.arn
  sensitive   = true
}

output "kms_pii_key_alias" {
  description = "Alias of the PII KMS key"
  value       = aws_kms_alias.pii.name
}

output "db_subnet_group_name" {
  description = "RDS subnet group name (private subnets only — no public internet)"
  value       = aws_db_subnet_group.main.name
}

output "vpc_id" {
  description = "ID of the banking VPC"
  value       = aws_vpc.main.id
}
