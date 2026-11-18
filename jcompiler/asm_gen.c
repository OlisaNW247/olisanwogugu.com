/*
 * asm_gen.c
 * Translates J tokens into RISC-V (RV32IM) assembly.
 *
 * Conventions:
 *  - The J stack is the machine stack: x2 (sp) points at the top value.
 *    Pushing is "addi x2, x2, -4 ; sw v, 0(x2)".
 *  - x8 (fp/s0) is the frame pointer and the prologue/epilogue match
 *    clang-19 at -O0 for RV32.
 *  - x5, x6, x7 (t0..t2) are scratch registers.
 *  - Function arguments live in x10..x17 (a0..a7) and the return value
 *    is in x10 (a0).
 *  - Compiler generated labels start with "__jc_" so they can never clash
 *    with a J function name (which has to start with a letter).
 */
#include "asm_gen.h"

#include <stdlib.h>

#define INITIAL_CTRL_CAPACITY 16

// ---------------------------------------------------------------------------
// Small helpers for writing common instruction sequences
// ---------------------------------------------------------------------------

// Pushes register reg onto the J stack.
static void emit_push_reg(FILE* out, const char* reg) {
  fprintf(out, "\taddi x2, x2, -4\n");
  fprintf(out, "\tsw %s, 0(x2)\n", reg);
}

// Pops the top of the J stack into register reg.
static void emit_pop_reg(FILE* out, const char* reg) {
  fprintf(out, "\tlw %s, 0(x2)\n", reg);
  fprintf(out, "\taddi x2, x2, 4\n");
}

// Loads any 32-bit constant into register reg.
static void emit_load_const(FILE* out, const char* reg, int value) {
  if (value >= -2048 && value <= 2047) {
    fprintf(out, "\taddi %s, x0, %d\n", reg, value);
    return;
  }
  // Split into an upper 20 bits and a sign-extended lower 12 bits so that
  // (upper << 12) + lower == value.
  unsigned int v = (unsigned int)value;
  int lower = (int)(v & 0xFFF);
  if (lower >= 2048) {
    lower -= 4096;
  }
  unsigned int upper = ((v - (unsigned int)lower) >> 12) & 0xFFFFF;
  fprintf(out, "\tlui %s, %u\n", reg, upper);
  if (lower != 0) {
    fprintf(out, "\taddi %s, %s, %d\n", reg, reg, lower);
  }
}

// Pops a (top) into x5 and b (next) into x6, leaving one free slot.
// After the operation the result in x5 should be stored with
// "sw x5, 0(x2)".
static void emit_binary_setup(FILE* out) {
  fprintf(out, "\tlw x5, 0(x2)\n");  // a = top    (rs1)
  fprintf(out, "\tlw x6, 4(x2)\n");  // b = next   (rs2)
  fprintf(out, "\taddi x2, x2, 4\n");
}

static void emit_binary_finish(FILE* out) {
  fprintf(out, "\tsw x5, 0(x2)\n");
}

static void emit_binary_op(FILE* out, const char* op) {
  emit_binary_setup(out);
  fprintf(out, "\t%s x5, x5, x6\n", op);
  emit_binary_finish(out);
}

// ---------------------------------------------------------------------------
// Control structure stack
// ---------------------------------------------------------------------------

static bool ctrl_push(compiler* c, token_type kind, int label_id) {
  if (c->ctrl_size == c->ctrl_capacity) {
    int new_cap = c->ctrl_capacity * 2;
    ctrl_entry* bigger = realloc(c->ctrl, sizeof(ctrl_entry) * new_cap);
    if (bigger == NULL) {
      fprintf(stderr, "jc: out of memory\n");
      return false;
    }
    c->ctrl = bigger;
    c->ctrl_capacity = new_cap;
  }
  c->ctrl[c->ctrl_size].kind = kind;
  c->ctrl[c->ctrl_size].label_id = label_id;
  c->ctrl[c->ctrl_size].seen_else = false;
  c->ctrl_size++;
  return true;
}

static ctrl_entry* ctrl_top(compiler* c) {
  if (c->ctrl_size == 0) {
    return NULL;
  }
  return &c->ctrl[c->ctrl_size - 1];
}

// ---------------------------------------------------------------------------
// Code generation for each kind of token
// ---------------------------------------------------------------------------

static void gen_function_start(compiler* c, const char* name) {
  FILE* out = c->out;
  if (!c->emitted_text) {
    fprintf(out, "\t.text\n");
    c->emitted_text = true;
  }
  fprintf(out, "\n\t.globl %s\n", name);
  fprintf(out, "%s:\n", name);
  // Prologue (same as clang-19 -O0, RV32)
  fprintf(out, "\taddi x2, x2, -16\n");
  fprintf(out, "\tsw x1, 12(x2)\n");
  fprintf(out, "\tsw x8, 8(x2)\n");
  fprintf(out, "\taddi x8, x2, 16\n");
}

static void gen_return(FILE* out) {
  // Return value is a copy of the top of the J stack.
  fprintf(out, "\tlw x10, 0(x2)\n");
  // Epilogue (same as clang-19 -O0, RV32). Resetting sp from fp discards
  // anything the function left on the J stack.
  fprintf(out, "\taddi x2, x8, -16\n");
  fprintf(out, "\tlw x1, 12(x2)\n");
  fprintf(out, "\tlw x8, 8(x2)\n");
  fprintf(out, "\taddi x2, x2, 16\n");
  fprintf(out, "\tjalr x0, 0(x1)\n");
}

static void gen_call(FILE* out, const char* name) {
  fprintf(out, "\tjal x1, %s\n", name);
  emit_push_reg(out, "x10");
}

static void gen_literal(FILE* out, int value) {
  emit_load_const(out, "x5", value);
  emit_push_reg(out, "x5");
}

static void gen_compare(FILE* out, token_type type) {
  // x5 = a (top), x6 = b (next)
  emit_binary_setup(out);
  switch (type) {
    case LT:  // a < b
      fprintf(out, "\tslt x5, x5, x6\n");
      break;
    case GT:  // a > b  ==  b < a
      fprintf(out, "\tslt x5, x6, x5\n");
      break;
    case LE:  // a <= b  ==  !(b < a)
      fprintf(out, "\tslt x5, x6, x5\n");
      fprintf(out, "\txori x5, x5, 1\n");
      break;
    case GE:  // a >= b  ==  !(a < b)
      fprintf(out, "\tslt x5, x5, x6\n");
      fprintf(out, "\txori x5, x5, 1\n");
      break;
    case EQ:  // a == b  ==  (a - b) == 0
      fprintf(out, "\tsub x5, x5, x6\n");
      fprintf(out, "\tsltiu x5, x5, 1\n");
      break;
    default:
      break;
  }
  emit_binary_finish(out);
}

static bool gen_if(compiler* c) {
  int id = c->next_label++;
  if (!ctrl_push(c, IF, id)) {
    return false;
  }
  emit_pop_reg(c->out, "x5");
  fprintf(c->out, "\tbeq x5, x0, __jc_else_%d\n", id);
  return true;
}

static bool gen_else(compiler* c) {
  ctrl_entry* top = ctrl_top(c);
  if (top == NULL || top->kind != IF || top->seen_else) {
    fprintf(stderr, "jc: 'else' without a matching 'if'\n");
    return false;
  }
  top->seen_else = true;
  fprintf(c->out, "\tjal x0, __jc_endif_%d\n", top->label_id);
  fprintf(c->out, "__jc_else_%d:\n", top->label_id);
  return true;
}

static bool gen_endif(compiler* c) {
  ctrl_entry* top = ctrl_top(c);
  if (top == NULL || top->kind != IF) {
    fprintf(stderr, "jc: 'endif' without a matching 'if'\n");
    return false;
  }
  if (!top->seen_else) {
    // No else: a false condition jumps straight here.
    fprintf(c->out, "__jc_else_%d:\n", top->label_id);
  }
  fprintf(c->out, "__jc_endif_%d:\n", top->label_id);
  c->ctrl_size--;
  return true;
}

static bool gen_while(compiler* c) {
  int id = c->next_label++;
  if (!ctrl_push(c, WHILE, id)) {
    return false;
  }
  fprintf(c->out, "__jc_while_%d:\n", id);
  emit_pop_reg(c->out, "x5");
  fprintf(c->out, "\tbeq x5, x0, __jc_endwhile_%d\n", id);
  return true;
}

static bool gen_endwhile(compiler* c) {
  ctrl_entry* top = ctrl_top(c);
  if (top == NULL || top->kind != WHILE) {
    fprintf(stderr, "jc: 'endwhile' without a matching 'while'\n");
    return false;
  }
  fprintf(c->out, "\tjal x0, __jc_while_%d\n", top->label_id);
  fprintf(c->out, "__jc_endwhile_%d:\n", top->label_id);
  c->ctrl_size--;
  return true;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

bool compiler_init(compiler* c, FILE* out) {
  c->out = out;
  c->ctrl_size = 0;
  c->ctrl_capacity = INITIAL_CTRL_CAPACITY;
  c->ctrl = malloc(sizeof(ctrl_entry) * INITIAL_CTRL_CAPACITY);
  c->next_label = 0;
  c->expecting_name = false;
  c->emitted_text = false;
  if (c->ctrl == NULL) {
    fprintf(stderr, "jc: out of memory\n");
    return false;
  }
  return true;
}

void compiler_free(compiler* c) {
  free(c->ctrl);
  c->ctrl = NULL;
  c->ctrl_size = 0;
  c->ctrl_capacity = 0;
}

bool gen_token(compiler* c, const token* t) {
  FILE* out = c->out;

  if (c->expecting_name) {
    if (t->type != IDENT) {
      fprintf(stderr, "jc: expected a function name after 'defun', got '%s'\n",
              t->str);
      return false;
    }
    c->expecting_name = false;
    gen_function_start(c, t->str);
    return true;
  }

  switch (t->type) {
    case DEFUN:
      if (c->ctrl_size != 0) {
        fprintf(stderr, "jc: 'defun' inside an unfinished if/while\n");
        return false;
      }
      c->expecting_name = true;
      return true;

    case IDENT:
      gen_call(out, t->str);
      return true;

    case RETURN:
      gen_return(out);
      return true;

    case LITERAL:
      gen_literal(out, t->literal_value);
      return true;

    // Arithmetic: a = top (rs1), b = next (rs2), result = a OP b
    case PLUS:
      emit_binary_op(out, "add");
      return true;
    case MINUS:
      emit_binary_op(out, "sub");
      return true;
    case MUL:
      emit_binary_op(out, "mul");
      return true;
    case DIV:
      emit_binary_op(out, "div");
      return true;
    case MOD:
      emit_binary_op(out, "rem");
      return true;

    // Bitwise logic
    case AND:
      emit_binary_op(out, "and");
      return true;
    case OR:
      emit_binary_op(out, "or");
      return true;
    case NOT:
      fprintf(out, "\tlw x5, 0(x2)\n");
      fprintf(out, "\txori x5, x5, -1\n");
      fprintf(out, "\tsw x5, 0(x2)\n");
      return true;

    // Comparisons
    case LT:
    case LE:
    case EQ:
    case GE:
    case GT:
      gen_compare(out, t->type);
      return true;

    // Stack operations
    case DROP:
      fprintf(out, "\taddi x2, x2, 4\n");
      return true;
    case DUP:
      fprintf(out, "\tlw x5, 0(x2)\n");
      emit_push_reg(out, "x5");
      return true;
    case SWAP:
      fprintf(out, "\tlw x5, 0(x2)\n");
      fprintf(out, "\tlw x6, 4(x2)\n");
      fprintf(out, "\tsw x5, 4(x2)\n");
      fprintf(out, "\tsw x6, 0(x2)\n");
      return true;
    case ROT:
      // ... c b a  ->  ... b a c   (a is the top)
      fprintf(out, "\tlw x5, 0(x2)\n");  // a
      fprintf(out, "\tlw x6, 4(x2)\n");  // b
      fprintf(out, "\tlw x7, 8(x2)\n");  // c
      fprintf(out, "\tsw x6, 8(x2)\n");
      fprintf(out, "\tsw x5, 4(x2)\n");
      fprintf(out, "\tsw x7, 0(x2)\n");
      return true;
    case SET_ARG:
      fprintf(out, "\tlw x%d, 0(x2)\n", 9 + t->arg_no);
      fprintf(out, "\taddi x2, x2, 4\n");
      return true;
    case GET_ARG:
      fprintf(out, "\taddi x2, x2, -4\n");
      fprintf(out, "\tsw x%d, 0(x2)\n", 9 + t->arg_no);
      return true;

    // Control flow
    case IF:
      return gen_if(c);
    case ELSE:
      return gen_else(c);
    case ENDIF:
      return gen_endif(c);
    case WHILE:
      return gen_while(c);
    case ENDWHILE:
      return gen_endwhile(c);

    case BAD_TOKEN:
    default:
      fprintf(stderr, "jc: illegal token '%s'\n", t->str);
      return false;
  }
}

bool compiler_finish(compiler* c) {
  bool ok = true;
  if (c->expecting_name) {
    fprintf(stderr, "jc: 'defun' at end of file with no function name\n");
    ok = false;
  }
  for (int i = c->ctrl_size - 1; i >= 0; i--) {
    fprintf(stderr, "jc: missing '%s'\n",
            c->ctrl[i].kind == IF ? "endif" : "endwhile");
    ok = false;
  }
  return ok;
}
