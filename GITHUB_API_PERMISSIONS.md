# GitHub API Permissions Reference

This document catalogs the GitHub OAuth scopes available for API access.

---

## Codespaces

| Scope | Description |
|-------|-------------|
| `codespace` | Full control of codespaces |
| `codespace:secrets` | Ability to create, read, update, and delete codespace secrets |

---

## Copilot

| Scope | Description |
|-------|-------------|
| `copilot` | Full control of GitHub Copilot settings and seat assignments |
| `manage_billing:copilot` | View and edit Copilot Business seat assignments |

---

## Hosted Compute Networks

| Scope | Description |
|-------|-------------|
| `write:network_configurations` | Write org hosted compute network configurations |
| `read:network_configurations` | Read org hosted compute network configurations |

---

## Projects

| Scope | Description |
|-------|-------------|
| `project` | Full control of projects |
| `read:project` | Read access of projects |

---

## GPG Keys

| Scope | Description |
|-------|-------------|
| `admin:gpg_key` | Full control of public user GPG keys |
| `write:gpg_key` | Write public user GPG keys |
| `read:gpg_key` | Read public user GPG keys |

---

## SSH Signing Keys

| Scope | Description |
|-------|-------------|
| `admin:ssh_signing_key` | Full control of public user SSH signing keys |
| `write:ssh_signing_key` | Write public user SSH signing keys |
| `read:ssh_signing_key` | Read public user SSH signing keys |
| `read:public_key` | Read user public keys |

---

## Repository Hooks

| Scope | Description |
|-------|-------------|
| `admin:repo_hook` | Full control of repository hooks |
| `write:repo_hook` | Write repository hooks |
| `read:repo_hook` | Read repository hooks |

---

## Organization Hooks

| Scope | Description |
|-------|-------------|
| `admin:org_hook` | Full control of organization hooks |

---

## Miscellaneous

| Scope | Description |
|-------|-------------|
| `gist` | Create gists |
| `notifications` | Access notifications |

---

## User

| Scope | Description |
|-------|-------------|
| `user` | Update ALL user data |
| `read:user` | Read ALL user profile data |
| `user:email` | Access user email addresses (read-only) |
| `user:follow` | Follow and unfollow users |
| `delete_repo` | Delete repositories |

---

## Discussions

| Scope | Description |
|-------|-------------|
| `write:discussion` | Read and write team discussions |
| `read:discussion` | Read team discussions |

---

## Enterprise

| Scope | Description |
|-------|-------------|
| `admin:enterprise` | Full control of enterprises |
| `manage_runners:enterprise` | Manage enterprise runners and runner groups |
| `manage_billing:enterprise` | Read and write enterprise billing data |
| `read:enterprise` | Read enterprise profile data |

---

## Repositories

| Scope | Description |
|-------|-------------|
| `repo` | Full control of private repositories |
| `repo:status` | Access commit status |
| `repo_deployment` | Access deployment status |
| `public_repo` | Access public repositories |
| `repo:invite` | Access repository invitations |
| `security_events` | Read and write security events |

---

## Actions & Packages

| Scope | Description |
|-------|-------------|
| `workflow` | Update GitHub Action workflows |
| `write:packages` | Upload packages to GitHub Package Registry |
| `read:packages` | Download packages from GitHub Package Registry |
| `delete:packages` | Delete packages from GitHub Package Registry |
