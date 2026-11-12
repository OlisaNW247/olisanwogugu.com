#ifndef DECODER_H_
#define DECODER_H_

#include <stdint.h>
#include <stdio.h>

// Every RV32I (+ M extension) instruction the disassembler recognizes.
// ILLEGAL_INSTR marks any 32-bit word that is not a legal instruction.
typedef enum {
  // R-type arithmetic / logic
  ADD,
  SUB,
  SLL,
  SLT,
  SLTU,
  XOR,
  SRL,
  SRA,
  OR,
  AND,

  // M extension (R-type)
  MUL,
  MULH,
  MULHSU,
  MULHU,
  DIV,
  DIVU,
  REM,
  REMU,

  // I-type arithmetic / logic
  ADDI,
  SLTI,
  SLTIU,
  XORI,
  ORI,
  ANDI,
  SLLI,
  SRLI,
  SRAI,

  // Loads (I-type)
  LB,
  LH,
  LW,
  LBU,
  LHU,

  // Stores (S-type)
  SB,
  SH,
  SW,

  // Branches (B-type)
  BEQ,
  BNE,
  BLT,
  BGE,
  BLTU,
  BGEU,

  // Jumps
  JAL,
  JALR,

  // U-type
  LUI,
  AUIPC,

  // System
  ECALL,
  EBREAK,

  ILLEGAL_INSTR,
} INSTR_TYPE;

// The decoded form of a single 32-bit RISC-V instruction.
// Fields an instruction does not use are left as 0.
typedef struct riscv_instr_st {
  INSTR_TYPE type;
  uint32_t rs1;
  uint32_t rs2;
  uint32_t rd;
  // The immediate, already sign- or zero-extended to 32 bits.
  // For LUI/AUIPC this is the full value placed in the register
  // (i.e. instr[31:12] << 12), exactly as the RISC-V spec defines it.
  int32_t imm;
} riscv_instr;

// Decodes the 32-bit instruction `instr` into its type, registers and
// immediate. Sets type to ILLEGAL_INSTR if `instr` is not a legal instruction.
riscv_instr decode_instr(uint32_t instr);

// Prints the mnemonic for `type` (e.g. "ADDI") to `file`.
void print_type(INSTR_TYPE type, FILE* file);

// Prints the assembly form of `instr` (e.g. "ADDI x10, x5, 1") to `file`.
// Prints "INVALID INSTRUCTION" for ILLEGAL_INSTR.
void print_instr(riscv_instr instr, FILE* file);

#endif  // DECODER_H_
