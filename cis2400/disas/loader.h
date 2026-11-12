#ifndef LOADER_H_
#define LOADER_H_

#include <stdint.h>

// Code memory begins at CODE_BASE, data memory at DATA_BASE.
// Each region holds MEM_SIZE (2^16) bytes.
#define CODE_BASE 0x10000000u
#define DATA_BASE 0x20000000u
#define MEM_SIZE 65536u

// The magic word every object file starts with.
#define OBJ_MAGIC 0xCAFEF00Du

// Section headers.
#define SECTION_CODE 0xC0DEu
#define SECTION_DATA 0xDADAu
#define SECTION_SYMBOL 0xC3B7u
#define SECTION_FILENAME 0xF17Eu
#define SECTION_LINENUM 0x715Eu

// The simulated RISC-V memory.
//   code[i] holds the byte at address CODE_BASE + i.
//   data[i] holds the byte at address DATA_BASE + i.
// Instruction words are stored most-significant byte first, so the word at
// CODE_BASE + 4 * k is code[4k] << 24 | ... | code[4k + 3].
typedef struct memory_st {
  uint8_t code[MEM_SIZE];
  uint8_t data[MEM_SIZE];
} memory;

// Sets every location in `mem` to zero.
void clear_memory(memory* mem);

// Loads the object file named `filename` into `mem`, overwriting any
// locations it specifies. Returns 0 on success, or -1 (after printing a
// message to stderr) if the file cannot be opened or is malformed.
int load_object_file(const char* filename, memory* mem);

// Returns the instruction word stored at byte offset `offset` (a multiple of
// 4, less than MEM_SIZE) of code memory.
uint32_t read_code_word(const memory* mem, uint32_t offset);

#endif  // LOADER_H_
