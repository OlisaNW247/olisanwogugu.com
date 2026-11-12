#ifndef DECODER_H_
#define DECODER_H_

#include <stdint.h>  // for sized integers
#include <stdio.h>   // for FILE

/*
 * decoder.h
 */

// Defines a new enumerated type 'INSTR_TYPE'
// which is used to identify the different types of instructions in RISC-V
// Each of the listed values e.g. ILLEGAL_INSTR, LUI, ADD, ... are
// possible values of the INSTR_TYPE.
typedef enum {
  ILLEGAL_INSTR,
  LUI, AUIPC,
  ADDI, SLTI, SLTIU, XORI, ORI, ANDI, SLLI, SRLI, SRAI,
  ADD, SUB, SLL, SLT, SLTU, XOR, SRL, SRA,  OR, AND,
  LB, LH, LW, LBU, LHU,
  SB, SH, SW,
  JAL, JALR,
  BEQ, BNE, BLT, BGE, BLTU, BGEU,
  MUL, MULH, MULHSU, MULHU,
  DIV, DIVU, REM, REMU,
} INSTR_TYPE;

// defines a constant "variable" that can be later used
// to indicate that any signal is ok for that signal value
#define ANY_SIGNAL -1

typedef struct {
  INSTR_TYPE type;       // Type of the instruction

  // contol signals (From an earlier assignment)
  int PCMuxCTL;
  int regFileWE;
  int regInputMuxCTL;
  int PCAddMuxCTL;
  int DATAWE;
  int DATAExtCTL;
  int ALUInputMuxCTL;
  int ALUCTL;

  // Needed for this assignment.
  int32_t rd, rs1, rs2;  // Register fields
  int32_t immediate;  // Immediate field of instruction 
} riscv_instr;


riscv_instr decode_instr(uint32_t instr_bits);

// Given an INSTR_TYPE, prints out the corresponding string for that type to the specified file.
// This is provided for debugging purposes, you should not need to modify the method.
void print_type(INSTR_TYPE type, FILE* file);

// Prints the assembly form of `instr` (e.g. "ADDI x10, x5, 1") to `file`,
// or "INVALID INSTRUCTION" if instr.type is ILLEGAL_INSTR.
void print_instr(riscv_instr instr, FILE* file);


#endif  // DECODER_H_
