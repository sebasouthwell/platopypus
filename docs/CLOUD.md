# Cloud accounts for agents — request, approve, scope (roadmap, not built)

Agents never hold a cloud account's own key. When an agent in a project needs AWS (or another provider), it asks,
the user approves a scope on the phone, and PlatOpypus hands out short-lived credentials that the provider itself
restricts to that scope. The scope file the agent reads is the explanation; the provider is the enforcement.

## Flow

1. **The agent proposes.** From the project's main folder it runs, for example:

   ```
   cloud request aws --reason "S3 bucket for Parle audio uploads" --scope-file cloud-scope.proposed.yaml
   ```

   The proposal names capabilities from a short, provider-neutral list, not provider permissions:

   ```yaml
   account: personal          # a Cloud accounts profile; the user may switch it on approval
   capabilities: [storage, functions]
   region: eu-west-2
   duration: 1h               # lifetime of each credential; max 12h
   budget_usd: 5
   ```

2. **The phone asks** with checkboxes, the agent's proposal pre-ticked and its reason above them:

   | Checkbox | Means |
   |---|---|
   | **Read only** | list and read this project's resources, change nothing |
   | **Storage** | buckets and the files in them |
   | **Databases** | managed databases and their backups |
   | **Functions** | serverless functions and their triggers |
   | **Servers** | virtual machines, disks, addresses, firewall rules |
   | **DNS** | records under this project's hostnames only |
   | **Delete** | remove resources this project created (off unless ticked) |

   Below them: region, duration and monthly budget, with the account picker. **Allow** or **Deny**; nothing happens
   without a tap. Everything is always limited to resources tagged or named for this project, so no checkbox can
   reach another project or anything the box itself uses.

   PlatOpypus owns the translation from checkboxes to each provider's real permissions (AWS IAM actions, GCP roles,
   Azure built-in roles, Cloudflare token permission groups, Vercel project-scoped tokens) in one mapping file per
   provider. Neither the user nor the agent ever writes provider permission names.

3. **PlatOpypus records the grant** in the project as `cloud-scope.yaml` (read-only for agents, committed only if the
   user wants) and in its own state, with who approved it and when.

4. **The agent gets credentials, never the key.** `cloud creds aws` (from the project's main folder only, like
   `vault get`) returns short-lived credentials made from the approved checkboxes. On AWS: an STS role session whose
   session policy is generated from the provider mapping, with every resource name constrained to the approved prefixes and regions, and a
   `porthole:project=<name>` tag that new resources must carry. AWS rejects anything outside the scope, whatever the
   agent tries. Credentials expire after `duration`; asking again within an active grant needs no new tap.

5. **Revoke** from the phone at any time: the grant is deleted, outstanding sessions are invalidated (the role's
   session-revocation policy), and the project page lists the resources tagged for that project so they can be kept
   or destroyed.

## Account setup: assigned role or stored key

A Cloud accounts profile gets its identity one of two ways. PlatOpypus prefers the first and detects it on its own.

- **Assigned role (preferred).** The box itself is given an identity by the platform: an EC2 instance profile on AWS,
  an attached service account on GCP, a managed identity on Azure. PlatOpypus finds it at start-up through the
  platform's metadata service (IMDSv2 on AWS) and shows the profile as *assigned role · no stored key*. Nothing
  secret is stored in the Vault; credentials rotate automatically.
- **Stored key (fallback).** For accounts the box does not live in, or local test boxes: a key in the Vault, used
  only to assume the PlatOpypus role in that account.

Either way the identity PlatOpypus holds can do exactly one useful thing: assume `porthole-agent`, a role created at
setup whose own policy is the outer limit (tag-scoped create/delete, no IAM user or key creation, no billing, no
organisation changes). Each grant then narrows it further with a session policy for one project and its
checkboxes. The permission model is the same whichever way the identity arrived.

**Perks of an assigned role, used throughout PlatOpypus** (each still subject to its own checkbox or setting):
backups to the private S3 bucket without a stored key, reading `/porthole/*` SSM parameters at boot, the cost line
on Cloud accounts from Cost Explorer, Terraform for own-host services without exporting keys, and the box's own
start/stop schedule.

**Keeping agents off the box's identity.** The metadata service is reachable by any process on the box, so it is
locked down: the instance role itself only allows `sts:AssumeRole` on `porthole-agent` (and the perks above), IMDSv2
is required with a hop limit of 1 so containers cannot reach it, and an nftables rule drops traffic to
169.254.169.254 from every user except the one PlatOpypus runs as. That last rule only bites once agents run as their
own non-root user, which this design assumes; while agents run as root it is a speed bump, and the narrow instance
role is what limits the damage.

## Other providers

The same flow and the same checkboxes for every provider; only the mapping and the credential type differ: GCP
short-lived service-account tokens with a credential access boundary, Azure a scoped service principal secret with a
short expiry, Cloudflare an API token generated per grant (zone- and resource-limited, with an expiry), Vercel a
team token limited to the project. A provider without a way to issue limited, expiring credentials is offered
read-only or not at all.

## Why not just a scope file

A file only tells a well-behaved agent what it should do. Generating the session policy from the same file makes the
provider enforce it, so a confused or prompt-injected agent cannot reach other resources, other regions or other
projects' buckets.
