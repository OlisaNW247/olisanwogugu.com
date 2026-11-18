/*
 * token.c
 * Reads tokens from a J source file.
 */
#include "token.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  const char* word;
  token_type type;
} keyword;

static const keyword KEYWORDS[] = {
    {"defun", DEFUN}, {"return", RETURN},  {"+", PLUS},    {"-", MINUS},
    {"*", MUL},       {"/", DIV},          {"%", MOD},     {"and", AND},
    {"or", OR},       {"not", NOT},        {"lt", LT},     {"le", LE},
    {"eq", EQ},       {"ge", GE},          {"gt", GT},     {"if", IF},
    {"else", ELSE},   {"endif", ENDIF},    {"while", WHILE},
    {"endwhile", ENDWHILE},                {"drop", DROP}, {"dup", DUP},
    {"swap", SWAP},   {"rot", ROT},
};

static const char* TYPE_NAMES[] = {
    "DEFUN", "IDENT", "RETURN", "PLUS",  "MINUS", "MUL",      "DIV",
    "MOD",   "AND",   "OR",     "NOT",   "LT",    "LE",       "EQ",
    "GE",    "GT",    "IF",     "ELSE",  "ENDIF", "WHILE",    "ENDWHILE",
    "DROP",  "DUP",   "SWAP",   "ROT",   "SET_ARG", "GET_ARG", "LITERAL",
    "BAD_TOKEN",
};

// Skips whitespace and comments. Returns the first character of the next
// token (or EOF).
static int skip_space_and_comments(FILE* f) {
  int c;
  while ((c = fgetc(f)) != EOF) {
    if (c == ';') {
      // Comment: discard the rest of the line.
      while ((c = fgetc(f)) != EOF && c != '\n') {
      }
      if (c == EOF) {
        return EOF;
      }
    } else if (!isspace(c)) {
      return c;
    }
  }
  return EOF;
}

// Returns true if s is an optional '-' followed by one or more digits.
static bool is_decimal(const char* s) {
  if (*s == '-') {
    s++;
  }
  if (*s == '\0') {
    return false;
  }
  for (; *s != '\0'; s++) {
    if (!isdigit((unsigned char)*s)) {
      return false;
    }
  }
  return true;
}

// Returns true if s is 0x (or 0X) followed by 1 to 8 hex digits.
static bool is_hex(const char* s) {
  if (s[0] != '0' || (s[1] != 'x' && s[1] != 'X')) {
    return false;
  }
  s += 2;
  size_t len = strlen(s);
  if (len == 0 || len > 8) {
    return false;
  }
  for (; *s != '\0'; s++) {
    if (!isxdigit((unsigned char)*s)) {
      return false;
    }
  }
  return true;
}

// Returns true if s is a legal identifier: a letter followed by letters,
// digits or underscores.
static bool is_ident(const char* s) {
  if (!isalpha((unsigned char)*s)) {
    return false;
  }
  for (s++; *s != '\0'; s++) {
    if (!isalnum((unsigned char)*s) && *s != '_') {
      return false;
    }
  }
  return true;
}

// Matches "<prefix>N" with N in 1..8. Returns N, or 0 on no match.
static int match_arg(const char* s, const char* prefix) {
  size_t plen = strlen(prefix);
  if (strncmp(s, prefix, plen) != 0) {
    return 0;
  }
  s += plen;
  if (s[0] >= '1' && s[0] <= '8' && s[1] == '\0') {
    return s[0] - '0';
  }
  return 0;
}

// Fills in output->type (and value fields) based on output->str.
static bool classify(token* output) {
  const char* s = output->str;

  for (size_t i = 0; i < sizeof(KEYWORDS) / sizeof(KEYWORDS[0]); i++) {
    if (strcmp(s, KEYWORDS[i].word) == 0) {
      output->type = KEYWORDS[i].type;
      return true;
    }
  }

  int n;
  if ((n = match_arg(s, "set_arg")) != 0) {
    output->type = SET_ARG;
    output->arg_no = n;
    return true;
  }
  if ((n = match_arg(s, "get_arg")) != 0) {
    output->type = GET_ARG;
    output->arg_no = n;
    return true;
  }

  if (is_hex(s)) {
    output->type = LITERAL;
    output->literal_value = (int)(unsigned int)strtoul(s + 2, NULL, 16);
    return true;
  }
  if (is_decimal(s)) {
    output->type = LITERAL;
    // Parse wide, then truncate to 32 bits (2C).
    output->literal_value = (int)(unsigned int)strtoll(s, NULL, 10);
    return true;
  }

  if (is_ident(s)) {
    output->type = IDENT;
    return true;
  }

  output->type = BAD_TOKEN;
  return false;
}

bool next_token(FILE* j_file, token* output) {
  output->type = BAD_TOKEN;
  output->str[0] = '\0';
  output->literal_value = 0;
  output->arg_no = 0;

  if (j_file == NULL) {
    return false;
  }

  int c = skip_space_and_comments(j_file);
  if (c == EOF) {
    return false;
  }

  size_t len = 0;
  while (c != EOF && !isspace(c) && c != ';') {
    if (len < MAX_TOKEN_LENGTH) {
      output->str[len++] = (char)c;
    }
    c = fgetc(j_file);
  }
  output->str[len] = '\0';
  if (c == ';') {
    // Leave the comment for the next call to skip.
    ungetc(c, j_file);
  }

  return classify(output);
}

void print_token(FILE* f, token to_print) {
  if (f == NULL) {
    return;
  }
  const char* name = "UNKNOWN";
  if ((int)to_print.type >= 0 && to_print.type <= BAD_TOKEN) {
    name = TYPE_NAMES[to_print.type];
  }
  switch (to_print.type) {
    case LITERAL:
      fprintf(f, "%s %d (\"%s\")\n", name, to_print.literal_value,
              to_print.str);
      break;
    case SET_ARG:
    case GET_ARG:
      fprintf(f, "%s %d\n", name, to_print.arg_no);
      break;
    case IDENT:
    case BAD_TOKEN:
      fprintf(f, "%s \"%s\"\n", name, to_print.str);
      break;
    default:
      fprintf(f, "%s\n", name);
      break;
  }
}
