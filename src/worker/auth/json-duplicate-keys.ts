/**
 * JSON.parse 会静默保留同名顶层字段的最后一个值，strict schema 因此看不到
 * 重复参数。这里在解析之前扫描原始文本的顶层成员名，供网关拒绝歧义请求。
 */
const stringEscapes: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
}

function skipWhitespace(raw: string, start: number): number {
  let index = start
  while (index < raw.length && " \t\n\r".includes(raw[index]!)) index += 1
  return index
}

/** 从 opening quote 开始读取一个 JSON 字符串，转义序列按 JSON 语义解码。 */
function readJsonString(
  raw: string,
  start: number,
): { end: number; value: string } | undefined {
  let value = ""
  let index = start + 1
  while (index < raw.length) {
    const character = raw[index]!
    if (character === '"') return { end: index + 1, value }
    if (character === "\\") {
      const escape = raw[index + 1]
      if (escape === "u") {
        const hex = raw.slice(index + 2, index + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined
        value += String.fromCharCode(Number.parseInt(hex, 16))
        index += 6
        continue
      }
      const decoded = escape === undefined ? undefined : stringEscapes[escape]
      if (decoded === undefined) return undefined
      value += decoded
      index += 2
      continue
    }
    value += character
    index += 1
  }
  return undefined
}

/** 跳过任意 JSON 值，返回其后的下标；字符串与嵌套结构按深度配对。 */
function skipJsonValue(raw: string, start: number): number | undefined {
  let index = skipWhitespace(raw, start)
  const character = raw[index]
  if (character === undefined) return undefined
  if (character === '"') return readJsonString(raw, index)?.end
  if (character === "{" || character === "[") {
    let depth = 0
    while (index < raw.length) {
      const current = raw[index]!
      if (current === '"') {
        const string = readJsonString(raw, index)
        if (!string) return undefined
        index = string.end
        continue
      }
      if (current === "{" || current === "[") depth += 1
      else if (current === "}" || current === "]") {
        depth -= 1
        index += 1
        if (depth === 0) return index
        continue
      }
      index += 1
    }
    return undefined
  }
  while (index < raw.length && !",}] \t\n\r".includes(raw[index]!)) index += 1
  return index
}

/**
 * 返回顶层对象中重复出现的成员名（按 JSON 转义解码后比较）。输入不是
 * 顶层对象或无法扫描时返回空数组，由常规 JSON 解析负责报错。
 */
export function duplicateTopLevelJsonKeys(raw: string): string[] {
  let index = skipWhitespace(raw, 0)
  if (raw[index] !== "{") return []
  index = skipWhitespace(raw, index + 1)
  if (raw[index] === "}") return []

  const seen = new Set<string>()
  const duplicates: string[] = []
  while (index < raw.length) {
    if (raw[index] !== '"') return duplicates
    const key = readJsonString(raw, index)
    if (!key) return duplicates
    if (seen.has(key.value)) duplicates.push(key.value)
    seen.add(key.value)
    index = skipWhitespace(raw, key.end)
    if (raw[index] !== ":") return duplicates
    const valueEnd = skipJsonValue(raw, index + 1)
    if (valueEnd === undefined) return duplicates
    index = skipWhitespace(raw, valueEnd)
    if (raw[index] === ",") {
      index = skipWhitespace(raw, index + 1)
      continue
    }
    return duplicates
  }
  return duplicates
}
