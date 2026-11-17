import { dirname } from "path";
import { fileURLToPath } from "url";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "public/sw.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...compat.extends("next/core-web-vitals"),
  {
    languageOptions: {
      ecmaVersion: 2023,
    },
    rules: {
      "react/no-unescaped-entities": "off",
    },
  },
  {
    // A plain <form> with a credential field submits itself as a GET (values in
    // the URL) whenever the JS bundle is slow or fails to load.
    files: ["src/**/*.tsx"],
    ignores: ["src/components/ui/CredentialForm.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...[
          "JSXAttribute[name.name='type'][value.value='password']",
          "JSXAttribute[name.name='autoComplete'][value.value=/password|one-time-code/]",
          "JSXOpeningElement[name.name='MaskedField']",
        ].map((field) => ({
          selector: `JSXElement[openingElement.name.name='form'] ${field}`,
          message:
            "A form with a password, secret, token or code field must be <CredentialForm> (components/ui/CredentialForm): method=post and disabled until hydrated, so a native submit can't put the value in the URL.",
        })),
        {
          selector: "JSXOpeningElement[name.name='form'] > JSXAttribute[name.name='method'][value.value=/^get$/i]",
          message: "No GET forms: a native submit puts every field in the URL. Use method=\"post\" (or <CredentialForm>).",
        },
      ],
    },
  },
];

export default config;
