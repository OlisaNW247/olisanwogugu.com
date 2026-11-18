/*
 * token.h
 * Token definitions and the tokenizer interface for the J compiler (jc).
 */
#ifndef TOKEN_H
#define TOKEN_H

#include <stdbool.h>
#include <stdio.h>

// No token in a J file is longer than 250 characters.
#define MAX_TOKEN_LENGTH 250

typedef enum token_type_t {
  DEFUN,     // defun
  IDENT,     // function name (definition or call)
  RETURN,    // return
  PLUS,      // +
  MINUS,     // -
  MUL,       // *
  DIV,       // /
  MOD,       // %
  AND,       // and
  OR,        // or
  NOT,       // not
  LT,        // lt
  LE,        // le
  EQ,        // eq
  GE,        // ge
  GT,        // gt
  IF,        // if
  ELSE,      // else
  ENDIF,     // endif
  WHILE,     // while
  ENDWHILE,  // endwhile
  DROP,      // drop
  DUP,       // dup
  SWAP,      // swap
  ROT,       // rot
  SET_ARG,   // set_arg1 ... set_arg8 (arg_no holds N)
  GET_ARG,   // get_arg1 ... get_arg8 (arg_no holds N)
  LITERAL,   // decimal or hex literal (literal_value holds the value)
  BAD_TOKEN  // anything that is not a legal token
} token_type;

typedef struct token_st {
  token_type type;
  // The text of the token as it appeared in the file (null terminated).
  char str[MAX_TOKEN_LENGTH + 1];
  // Only meaningful when type == LITERAL.
  int literal_value;
  // Only meaningful when type == SET_ARG or GET_ARG (1..8).
  int arg_no;
} token;

/*
 * Reads the next token from j_file into *output, skipping whitespace
 * and comments.
 *
 * Returns true if a legal token was read. Returns false if the end of
 * the file was reached before any token (output->type is left as
 * BAD_TOKEN and output->str is empty) or if the text read is not a
 * legal token (output->type is BAD_TOKEN and output->str holds the text).
 */
bool next_token(FILE* j_file, token* output);

/*
 * Prints a human readable description of the token to f.
 * Intended for debugging.
 */
void print_token(FILE* f, token to_print);

#endif  // TOKEN_H
