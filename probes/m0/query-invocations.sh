#!/usr/bin/env bash
# M0 数据采集:读取 Worker invocation 耗时分布(Cloudflare GraphQL Analytics API)
#
# 用法:
#   ./probes/m0/query-invocations.sh <script-name> <since-UTC> <until-UTC>
# 例:
#   ./probes/m0/query-invocations.sh eruoo-server-staging 2026-09-04T14:00:00Z 2026-09-04T16:00:00Z
#
# 说明:
# - 凭证复用 wrangler 本地 OAuth token(~/Library/Preferences/.wrangler/config/default.toml)
# - workersInvocationsAdaptive 的 quantiles 单位为 μs(以 tail 交叉验证锁定,见 platform-facts.md §3)
# - scheduled(cron)invocation 同样可见,dimensions.datetime 即触发时刻

set -euo pipefail

SCRIPT_NAME="${1:?usage: query-invocations.sh <script-name> <since> <until>}"
SINCE="${2:?usage: query-invocations.sh <script-name> <since> <until>}"
UNTIL="${3:?usage: query-invocations.sh <script-name> <since> <until>}"
ACCOUNT_TAG="1d204c847b5870d3438dc79534b91798"
TOKEN="$(grep -o 'oauth_token = "[^"]*"' "$HOME/Library/Preferences/.wrangler/config/default.toml" | cut -d'"' -f2)"

QUERY='query($tag: String!, $script: String!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: {accountTag: $tag}) {
      workersInvocationsAdaptive(
        filter: {scriptName: $script, datetime_geq: $since, datetime_leq: $until}
        limit: 100
        orderBy: [datetime_ASC]
      ) {
        dimensions { datetime status }
        quantiles { wallTimeP50 wallTimeP99 cpuTimeP50 }
        sum { requests errors }
      }
    }
  }
}'

curl -s "https://api.cloudflare.com/client/v4/graphql" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data "$(jq -n --arg q "$QUERY" --arg tag "$ACCOUNT_TAG" --arg script "$SCRIPT_NAME" --arg since "$SINCE" --arg until "$UNTIL" '{query: $q, variables: {tag: $tag, script: $script, since: $since, until: $until}}')" \
  | jq -r '.data.viewer.accounts[0].workersInvocationsAdaptive[]
      | [.dimensions.datetime[5:19], .dimensions.status, .sum.requests, (.quantiles.wallTimeP50/1000|tostring), (.quantiles.wallTimeP99/1000|tostring), (.quantiles.cpuTimeP50/1000|tostring)]
      | @tsv' \
  | awk 'BEGIN {print "time(UTC)\tstatus\tn\twallP50(ms)\twallP99(ms)\tcpuP50(ms)"} {print}'
