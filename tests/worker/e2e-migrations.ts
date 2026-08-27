type SqlState =
  | "block-comment"
  | "double"
  | "line-comment"
  | "normal"
  | "single"

export function splitD1MigrationStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ""
  let state: SqlState = "normal"

  const finishStatement = () => {
    const statement = current.trim()
    if (statement) statements.push(statement)
    current = ""
  }

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]
    const next = sql[index + 1]

    if (state === "line-comment") {
      if (character === "\n" || character === "\r") {
        current += character
        state = "normal"
      }
      continue
    }

    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        current += " "
        state = "normal"
        index += 1
      }
      continue
    }

    if (state === "single") {
      current += character
      if (character === "'" && next === "'") {
        current += next
        index += 1
      } else if (character === "'") {
        state = "normal"
      }
      continue
    }

    if (state === "double") {
      current += character
      if (character === '"' && next === '"') {
        current += next
        index += 1
      } else if (character === '"') {
        state = "normal"
      }
      continue
    }

    if (character === "-" && next === "-") {
      state = "line-comment"
      index += 1
      continue
    }

    if (character === "/" && next === "*") {
      state = "block-comment"
      index += 1
      continue
    }

    if (character === "'") {
      current += character
      state = "single"
      continue
    }

    if (character === '"') {
      current += character
      state = "double"
      continue
    }

    if (character === ";") {
      finishStatement()
      continue
    }

    current += character
  }

  if (state === "block-comment" || state === "double" || state === "single") {
    throw new Error("The E2E migration contains an unterminated SQL token.")
  }

  finishStatement()
  return statements
}
