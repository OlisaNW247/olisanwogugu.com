/*
 * jc.c
 * The J compiler: ./jc source.j  ->  source.s
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "asm_gen.h"
#include "token.h"

// Builds the output file name: "dir/foo.j" -> "dir/foo.s".
// If the name doesn't end in ".j", ".s" is appended.
// Returns a malloc'd string the caller must free, or NULL.
static char* make_output_name(const char* input) {
  size_t len = strlen(input);
  size_t base_len = len;
  if (len >= 2 && strcmp(input + len - 2, ".j") == 0) {
    base_len = len - 2;
  }
  char* name = malloc(base_len + 3);
  if (name == NULL) {
    return NULL;
  }
  memcpy(name, input, base_len);
  strcpy(name + base_len, ".s");
  return name;
}

int main(int argc, char** argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: %s <source.j>\n", argv[0]);
    return EXIT_FAILURE;
  }

  FILE* in = fopen(argv[1], "r");
  if (in == NULL) {
    fprintf(stderr, "jc: could not open '%s'\n", argv[1]);
    return EXIT_FAILURE;
  }

  char* out_name = make_output_name(argv[1]);
  if (out_name == NULL) {
    fprintf(stderr, "jc: out of memory\n");
    fclose(in);
    return EXIT_FAILURE;
  }

  FILE* out = fopen(out_name, "w");
  if (out == NULL) {
    fprintf(stderr, "jc: could not create '%s'\n", out_name);
    free(out_name);
    fclose(in);
    return EXIT_FAILURE;
  }

  compiler comp;
  bool ok = compiler_init(&comp, out);

  token t;
  while (ok) {
    if (!next_token(in, &t)) {
      if (t.str[0] != '\0') {
        fprintf(stderr, "jc: illegal token '%s'\n", t.str);
        ok = false;
      }
      break;  // end of file (or bad token)
    }
    ok = gen_token(&comp, &t);
  }

  if (ok) {
    ok = compiler_finish(&comp);
  }

  compiler_free(&comp);
  fclose(in);
  fclose(out);

  if (!ok) {
    fprintf(stderr, "jc: compilation of '%s' failed\n", argv[1]);
    remove(out_name);
    free(out_name);
    return EXIT_FAILURE;
  }

  free(out_name);
  return EXIT_SUCCESS;
}
