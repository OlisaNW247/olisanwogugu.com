#include "loader.h"

#include <arpa/inet.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

/* ------------------------------------------------------------------------- */
/* Big-endian readers                                                         */
/* ------------------------------------------------------------------------- */

// Each reader returns 0 on success and -1 if the file ended early.

static int read_half(FILE* file, uint16_t* out) {
  uint16_t raw;
  if (fread(&raw, sizeof(raw), 1, file) != 1) {
    return -1;
  }
  *out = ntohs(raw);
  return 0;
}

static int read_word(FILE* file, uint32_t* out) {
  uint32_t raw;
  if (fread(&raw, sizeof(raw), 1, file) != 1) {
    return -1;
  }
  *out = ntohl(raw);
  return 0;
}

// Reads and throws away `n` bytes.
static int skip_bytes(FILE* file, uint32_t n) {
  uint8_t buf[256];
  while (n > 0) {
    size_t chunk = (n < sizeof(buf)) ? n : sizeof(buf);
    if (fread(buf, 1, chunk, file) != chunk) {
      return -1;
    }
    n -= (uint32_t)chunk;
  }
  return 0;
}

/* ------------------------------------------------------------------------- */
/* Memory writes                                                              */
/* ------------------------------------------------------------------------- */

// Stores `value` at RISC-V address `addr`. Addresses outside the simulated
// code and data regions are ignored.
static void write_byte(memory* mem, uint32_t addr, uint8_t value) {
  if (addr >= CODE_BASE && addr - CODE_BASE < MEM_SIZE) {
    mem->code[addr - CODE_BASE] = value;
  } else if (addr >= DATA_BASE && addr - DATA_BASE < MEM_SIZE) {
    mem->data[addr - DATA_BASE] = value;
  }
}

// Stores the 32-bit `word` at `addr`, most-significant byte first.
static void write_word(memory* mem, uint32_t addr, uint32_t word) {
  write_byte(mem, addr, (uint8_t)(word >> 24));
  write_byte(mem, addr + 1, (uint8_t)(word >> 16));
  write_byte(mem, addr + 2, (uint8_t)(word >> 8));
  write_byte(mem, addr + 3, (uint8_t)word);
}

/* ------------------------------------------------------------------------- */
/* Section parsers                                                            */
/* ------------------------------------------------------------------------- */

// Code: <address> <n> then n instruction words.
static int load_code_section(FILE* file, memory* mem) {
  uint32_t addr;
  uint32_t n;
  if (read_word(file, &addr) || read_word(file, &n)) {
    return -1;
  }
  for (uint32_t i = 0; i < n; i++) {
    uint32_t word;
    if (read_word(file, &word)) {
      return -1;
    }
    write_word(mem, addr + 4 * i, word);
  }
  return 0;
}

// Data: <address> <n> then n bytes.
static int load_data_section(FILE* file, memory* mem) {
  uint32_t addr;
  uint32_t n;
  if (read_word(file, &addr) || read_word(file, &n)) {
    return -1;
  }
  for (uint32_t i = 0; i < n; i++) {
    uint8_t byte;
    if (fread(&byte, 1, 1, file) != 1) {
      return -1;
    }
    write_byte(mem, addr + i, byte);
  }
  return 0;
}

// Symbol: <address> <n> then n characters. Read and discarded.
static int skip_symbol_section(FILE* file) {
  uint32_t addr;
  uint32_t n;
  if (read_word(file, &addr) || read_word(file, &n)) {
    return -1;
  }
  return skip_bytes(file, n);
}

// File name: <n> then n characters. Read and discarded.
static int skip_filename_section(FILE* file) {
  uint32_t n;
  if (read_word(file, &n)) {
    return -1;
  }
  return skip_bytes(file, n);
}

// Line number: <address> <line> <file-index>, no body. Read and discarded.
static int skip_linenum_section(FILE* file) {
  uint32_t addr;
  uint32_t line;
  uint32_t file_index;
  if (read_word(file, &addr) || read_word(file, &line) ||
      read_word(file, &file_index)) {
    return -1;
  }
  return 0;
}

/* ------------------------------------------------------------------------- */
/* Public interface                                                           */
/* ------------------------------------------------------------------------- */

void clear_memory(memory* mem) { memset(mem, 0, sizeof(*mem)); }

uint32_t read_code_word(const memory* mem, uint32_t offset) {
  return ((uint32_t)mem->code[offset] << 24) |
         ((uint32_t)mem->code[offset + 1] << 16) |
         ((uint32_t)mem->code[offset + 2] << 8) |
         (uint32_t)mem->code[offset + 3];
}

int load_object_file(const char* filename, memory* mem) {
  FILE* file = fopen(filename, "rb");
  if (file == NULL) {
    fprintf(stderr, "disas: could not open object file '%s'\n", filename);
    return -1;
  }

  uint32_t magic;
  if (read_word(file, &magic) || magic != OBJ_MAGIC) {
    fprintf(stderr, "disas: '%s' is not a RISC-V object file\n", filename);
    fclose(file);
    return -1;
  }

  int result = 0;
  uint16_t header;
  // Read sections until the file cleanly ends.
  while (read_half(file, &header) == 0) {
    int err;
    switch (header) {
      case SECTION_CODE:
        err = load_code_section(file, mem);
        break;
      case SECTION_DATA:
        err = load_data_section(file, mem);
        break;
      case SECTION_SYMBOL:
        err = skip_symbol_section(file);
        break;
      case SECTION_FILENAME:
        err = skip_filename_section(file);
        break;
      case SECTION_LINENUM:
        err = skip_linenum_section(file);
        break;
      default:
        fprintf(stderr, "disas: '%s' has an unknown section header 0x%04X\n",
                filename, header);
        result = -1;
        goto done;
    }
    if (err) {
      fprintf(stderr, "disas: '%s' ended in the middle of a section\n",
              filename);
      result = -1;
      goto done;
    }
  }

  // read_half fails at EOF (normal) or on a stray trailing byte / read error.
  if (ferror(file) || fgetc(file) != EOF) {
    fprintf(stderr, "disas: error reading '%s'\n", filename);
    result = -1;
  }

done:
  fclose(file);
  return result;
}
