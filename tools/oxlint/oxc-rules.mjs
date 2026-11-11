const NO_UNUSED_TEMPLATE_LITERAL_MESSAGE =
  "Do not use template literals without interpolation or special-character handling.";

const NO_USELESS_ELSE_MESSAGE =
  "Do not use an else block after a branch that exits early.";

/** Returns whether a static template needs template-literal syntax. */
function needsTemplateLiteral(raw) {
  return /[\\\r\n]/u.test(raw) || (raw.includes("'") && raw.includes('"'));
}

/** Returns whether a statement always exits the current branch. */
function exitsEarly(statement) {
  if (statement.type === "BlockStatement") {
    const lastStatement = statement.body[statement.body.length - 1];

    return lastStatement ? exitsEarly(lastStatement) : false;
  }

  if (
    statement.type === "BreakStatement" ||
    statement.type === "ContinueStatement" ||
    statement.type === "ReturnStatement" ||
    statement.type === "ThrowStatement"
  ) {
    return true;
  }

  return (
    statement.type === "IfStatement" &&
    statement.alternate !== null &&
    exitsEarly(statement.consequent) &&
    exitsEarly(statement.alternate)
  );
}

const noUnusedTemplateLiteral = {
  meta: {
    fixable: "code",
  },
  create(context) {
    return {
      TemplateLiteral(node) {
        if (
          node.expressions.length !== 0 ||
          node.quasis.length !== 1 ||
          node.parent?.type === "TaggedTemplateExpression"
        ) {
          return;
        }

        const quasi = node.quasis[0];
        const raw = quasi.value.raw;

        if (needsTemplateLiteral(raw)) {
          return;
        }

        context.report({
          message: NO_UNUSED_TEMPLATE_LITERAL_MESSAGE,
          node,
          fix(fixer) {
            const cooked = quasi.value.cooked;

            return cooked === null
              ? null
              : fixer.replaceText(node, JSON.stringify(cooked));
          },
        });
      },
    };
  },
};

const noUselessElse = {
  create(context) {
    return {
      IfStatement(node) {
        if (node.alternate && exitsEarly(node.consequent)) {
          context.report({
            message: NO_USELESS_ELSE_MESSAGE,
            node: node.alternate,
          });
        }
      },
    };
  },
};

/** Keeps project-specific rules that have no native Oxlint equivalent. */
export default {
  meta: {
    name: "lunar-spice",
  },
  rules: {
    "no-unused-template-literal": noUnusedTemplateLiteral,
    "no-useless-else": noUselessElse,
  },
};
