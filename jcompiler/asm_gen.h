/*
 * asm_gen.h
 * Translates J tokens into RISC-V (RV32IM) assembly.
 */
#ifndef ASM_GEN_H
#define ASM_GEN_H

#include <stdbool.h>
#include <stdio.h>

#include "token.h"

// One open if/while block.
typedef struct ctrl_entry_st {
  token_type kind;  // IF or WHILE
  int label_id;     // unique number used in this block's labels
  bool seen_else;   // only used for IF
} ctrl_entry;

typedef struct compiler_st {
  FILE* out;               // the .s file being written
  ctrl_entry* ctrl;        // stack of open if/while blocks
  int ctrl_size;
  int ctrl_capacity;
  int next_label;          // counter for unique labels
  bool expecting_name;     // the previous token was defun
  bool emitted_text;       // ".text" has been written
} compiler;

// Sets up a compiler that writes to out. Returns false if memory runs out.
bool compiler_init(compiler* c, FILE* out);

// Writes the assembly for one token. Returns false (and prints a message
// to stderr) if the token can't be compiled here.
bool gen_token(compiler* c, const token* t);

// Checks that the program ended cleanly (no unclosed if/while, no defun
// without a name). Returns false and prints a message if not.
bool compiler_finish(compiler* c);

// Frees memory the compiler holds. Does not close the output file.
void compiler_free(compiler* c);

#endif  // ASM_GEN_H
