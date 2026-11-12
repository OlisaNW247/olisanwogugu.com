CC = clang-19
CFLAGS = -Wall -g3 -gdwarf-4

OBJS = disas.o loader.o decoder.o

.PHONY: all clean

all: disas

disas: $(OBJS)
	$(CC) $(CFLAGS) -o disas $(OBJS)

disas.o: disas.c decoder.h loader.h
	$(CC) $(CFLAGS) -c disas.c

loader.o: loader.c loader.h
	$(CC) $(CFLAGS) -c loader.c

decoder.o: decoder.c decoder.h
	$(CC) $(CFLAGS) -c decoder.c

clean:
	rm -f $(OBJS) disas
