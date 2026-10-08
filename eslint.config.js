// ESLint is used for one rule Biome doesn't have: blank lines around if/const/let.
import tseslint from "typescript-eslint";

const padding = [
	{ blankLine: "always", prev: "*", next: ["if", "const", "let"] },
	{ blankLine: "always", prev: ["if", "const", "let"], next: "*" },
];

export default tseslint.config(
	{ ignores: ["dist/**", "node_modules/**"] },
	{
		files: ["**/*.ts"],
		languageOptions: { parser: tseslint.parser },
		rules: {
			"padding-line-between-statements": ["error", ...padding],
		},
	},
);
