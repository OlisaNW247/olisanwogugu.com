#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "decoder.h"
#include "loader.h"

// Writes every non-zero instruction word in code memory, with its decoding.
static void print_code(const memory* mem, FILE* out) {
  for (uint32_t offset = 0; offset < MEM_SIZE; offset += 4) {
    uint32_t word = read_code_word(mem, offset);
    if (word == 0) {
      continue;
    }
    fprintf(out, "%08x : %08x -> ", CODE_BASE + offset, word);
    print_instr(decode_instr(word), out);
    fprintf(out, "\n");
  }
}

// Writes every non-zero byte in data memory.
static void print_data(const memory* mem, FILE* out) {
  for (uint32_t i = 0; i < MEM_SIZE; i++) {
    if (mem->data[i] != 0) {
      fprintf(out, "%08x : %02x\n", DATA_BASE + i, mem->data[i]);
    }
  }
}

int main(int argc, char** argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: %s output_filename input.o [more.o ...]\n",
            argv[0]);
    return EXIT_FAILURE;
  }

  // Too large to comfortably fit on the stack (128 KiB).
  memory* mem = malloc(sizeof(memory));
  if (mem == NULL) {
    fprintf(stderr, "disas: out of memory\n");
    return EXIT_FAILURE;
  }
  clear_memory(mem);

  // Load in command-line order so later files overwrite earlier ones.
  for (int i = 2; i < argc; i++) {
    if (load_object_file(argv[i], mem) != 0) {
      free(mem);
      return EXIT_FAILURE;
    }
  }

  FILE* out = fopen(argv[1], "w");
  if (out == NULL) {
    fprintf(stderr, "disas: could not open output file '%s'\n", argv[1]);
    free(mem);
    return EXIT_FAILURE;
  }

  // Addresses are printed in increasing order: code (0x1...) then data (0x2...).
  print_code(mem, out);
  print_data(mem, out);

  fclose(out);
  free(mem);
  return EXIT_SUCCESS;
}
