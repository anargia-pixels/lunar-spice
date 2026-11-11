import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode, Token } from "@oxlint/plugins";

type Statement = ESTree.Statement | ESTree.ModuleDeclaration | ESTree.SwitchCase;

type TokenOrComment = Token | ESTree.Comment;

const CONTROL_TYPES = new Set([
	"ReturnStatement",
	"IfStatement",
	"SwitchStatement",
	"TryStatement",
	"ForStatement",
	"ForInStatement",
	"ForOfStatement",
	"WhileStatement",
	"DoWhileStatement",
]);

const TYPE_LIKE_TYPES = new Set([
	"FunctionDeclaration",
	"ClassDeclaration",
	"TSInterfaceDeclaration",
	"TSTypeAliasDeclaration",
]);

const OVERLOAD_TYPES = new Set(["TSDeclareFunction", "FunctionDeclaration"]);

function isSemicolonToken(token: TokenOrComment): boolean {
	return token.type === "Punctuator" && token.value === ";";
}

function isClosingBraceToken(token: TokenOrComment): boolean {
	return token.type === "Punctuator" && token.value === "}";
}

function isSingleLine(node: ESTree.Node): boolean {
	return node.loc.start.line === node.loc.end.line;
}

function isTokenOnSameLine(
	left: { loc: { end: { line: number } } },
	right: { loc: { start: { line: number } } },
): boolean {
	return left.loc.end.line === right.loc.start.line;
}

/** Unwrap labels and export wrappers so statement kind is visible. */
function innerStatement(node: ESTree.Node): ESTree.Node {
	let current = node;
	while (current.type === "LabeledStatement") current = current.body;
	if (
		(current.type === "ExportNamedDeclaration" ||
			current.type === "ExportDefaultDeclaration") &&
		current.declaration !== null &&
		current.declaration !== undefined
	) {
		return current.declaration;
	}
	return current;
}

function isImport(node: ESTree.Node): boolean {
	return node.type === "ImportDeclaration";
}

function isTopLevelNonImport(node: ESTree.Node): boolean {
	return node.parent.type === "Program" && !isImport(node);
}

function isTypeLike(node: ESTree.Node): boolean {
	return TYPE_LIKE_TYPES.has(innerStatement(node).type);
}

function isControlOrReturn(node: ESTree.Node): boolean {
	return CONTROL_TYPES.has(innerStatement(node).type);
}

function isMultilineBinding(node: ESTree.Node): boolean {
	const inner = innerStatement(node);
	return inner.type === "VariableDeclaration" && !isSingleLine(inner);
}

function isOverloadGroup(prev: ESTree.Node, next: ESTree.Node): boolean {
	const prevInner = innerStatement(prev);
	const nextInner = innerStatement(next);
	return prevInner.type === "TSDeclareFunction" && OVERLOAD_TYPES.has(nextInner.type);
}

/** Last token of a statement, ignoring a following ASI semicolon on the next line. */
function actualLastToken(sourceCode: SourceCode, node: ESTree.Node): TokenOrComment {
	const semiToken = sourceCode.getLastToken(node);
	if (semiToken === null) return node;
	const prevToken = sourceCode.getTokenBefore(semiToken);
	const nextToken = sourceCode.getTokenAfter(semiToken);
	const isAsiSemicolon =
		prevToken !== null &&
		nextToken !== null &&
		prevToken.start >= node.start &&
		isSemicolonToken(semiToken) &&
		!isTokenOnSameLine(prevToken, semiToken) &&
		isTokenOnSameLine(semiToken, nextToken);
	return isAsiSemicolon ? prevToken : semiToken;
}

function isBlockLike(sourceCode: SourceCode, node: ESTree.Node): boolean {
	const inner = innerStatement(node);
	if (inner.type === "DoWhileStatement" && inner.body.type === "BlockStatement") {
		return true;
	}
	const lastToken = sourceCode.getLastToken(node, (token) => !isSemicolonToken(token));
	if (lastToken === null || !isClosingBraceToken(lastToken)) return false;
	const owner = sourceCode.getNodeByRangeIndex(lastToken.start);
	return owner?.type === "BlockStatement" || owner?.type === "SwitchStatement";
}

function requiresBlankLine(
	sourceCode: SourceCode,
	prev: ESTree.Node,
	next: ESTree.Node,
): boolean {
	if (isImport(prev) && isImport(next)) return false;
	if (isOverloadGroup(prev, next)) return false;
	return (
		isTopLevelNonImport(prev) ||
		isTopLevelNonImport(next) ||
		isTypeLike(prev) ||
		isTypeLike(next) ||
		isMultilineBinding(prev) ||
		isMultilineBinding(next) ||
		isControlOrReturn(next) ||
		isBlockLike(sourceCode, prev)
	);
}

function hasBlankLine(
	sourceCode: SourceCode,
	prev: ESTree.Node,
	next: ESTree.Node,
): boolean {
	let prevToken = actualLastToken(sourceCode, prev);
	const nextToken =
		sourceCode.getFirstTokenBetween(prevToken, next, {
			includeComments: true,
			filter(token: TokenOrComment) {
				if (isTokenOnSameLine(prevToken, token)) {
					prevToken = token;
					return false;
				}
				return true;
			},
		}) ?? next;
	return nextToken.loc.start.line - prevToken.loc.end.line >= 2;
}

function insertBlankLine(
	sourceCode: SourceCode,
	prev: ESTree.Node,
	next: ESTree.Node,
) {
	return (fixer: {
		insertTextAfter: (nodeOrToken: TokenOrComment, text: string) => unknown;
	}) => {
		let prevToken = actualLastToken(sourceCode, prev);
		const nextToken =
			sourceCode.getFirstTokenBetween(prevToken, next, {
				includeComments: true,
				filter(token: TokenOrComment) {
					if (isTokenOnSameLine(prevToken, token)) {
						prevToken = token;
						return false;
					}
					return true;
				},
			}) ?? next;
		const insertText = isTokenOnSameLine(prevToken, nextToken) ? "\n\n" : "\n";
		return fixer.insertTextAfter(prevToken, insertText);
	};
}

function reportLoc(sourceCode: SourceCode, node: ESTree.Node) {
	if (isSingleLine(node)) return node.loc;
	const line = node.loc.start.line;
	const sourceLine = sourceCode.lines[line - 1];
	return {
		start: node.loc.start,
		end: {
			line,
			column: sourceLine === undefined ? node.loc.start.column : sourceLine.length,
		},
	};
}

function checkStatements(
	sourceCode: SourceCode,
	report: (diagnostic: {
		node: ESTree.Node;
		messageId: "expectedBlankLine";
		loc: ReturnType<typeof reportLoc>;
		fix: ReturnType<typeof insertBlankLine>;
	}) => void,
	statements: readonly Statement[],
): void {
	for (let index = 1; index < statements.length; index += 1) {
		const prev = statements[index - 1];
		const next = statements[index];
		if (prev === undefined || next === undefined) continue;
		if (!requiresBlankLine(sourceCode, prev, next)) continue;
		if (hasBlankLine(sourceCode, prev, next)) continue;
		report({
			node: next,
			messageId: "expectedBlankLine",
			loc: reportLoc(sourceCode, next),
			fix: insertBlankLine(sourceCode, prev, next),
		});
	}
}

/** Insert blank lines between declarations and logical statement groups. */
export const requireReadableSpacingRule = defineRule({
	meta: {
		type: "layout",
		docs: {
			description:
				"Require readable spacing between declarations and logical statement groups.",
		},
		fixable: "whitespace",
		messages: {
			expectedBlankLine: "Expected blank line before this statement.",
		},
		schema: [],
	},
	createOnce(context) {
		const check = (statements: readonly Statement[]) => {
			checkStatements(context.sourceCode, context.report, statements);
		};
		return {
			Program(node) {
				check(node.body);
			},
			BlockStatement(node) {
				check(node.body);
			},
			StaticBlock(node) {
				check(node.body);
			},
			SwitchCase(node) {
				check(node.consequent);
			},
		};
	},
});
