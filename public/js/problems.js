/* =========================================================================
   Problem set. Statements are Markdown. Samples are public (Run Sample Tests);
   hidden tests live in data/tests/<id>.json and are fetched when a solution is submitted.
   Generated dynamically by CODE//ARENA Admin Panel.
   ========================================================================= */

export const PROBLEMS = [
  {
    "id": "A",
    "title": "Balanced Signal",
    "difficulty": "Easy",
    "points": 100,
    "timeLimitMs": 2000,
    "statement": "A transmitter emits a signal as a string of `L` and `R` pulses. A segment is **balanced** when it holds the same number of `L` and `R` pulses.\n\nSplit the signal into the **maximum** number of contiguous balanced segments. Every pulse must belong to exactly one segment.\n\n### Input\nThe first line contains `n`, the length of the signal. The second line contains the string `s` of length `n`, made of the characters `L` and `R`.\n\n### Output\nPrint a single integer: the maximum number of balanced segments.",
    "constraints": [
      "2 \u2264 n \u2264 2 \u00d7 10\u2075",
      "s is balanced as a whole (so n is even)"
    ],
    "samples": [
      {
        "input": "10\nRLRRLLRLRL\n",
        "output": "4\n",
        "note": "RL \u00b7 RRLL \u00b7 RL \u00b7 RL"
      },
      {
        "input": "6\nRLLLRR\n",
        "output": "2\n",
        "note": "RL \u00b7 LLRR"
      }
    ]
  },
  {
    "id": "B",
    "title": "Matrix Walk",
    "difficulty": "Medium",
    "points": 200,
    "timeLimitMs": 2000,
    "statement": "A robot starts at the top-left cell of an `n \u00d7 m` grid and must reach the bottom-right cell, moving only **right** or **down**. Every cell has an energy cost.\n\nFind the minimum total cost of a path, counting both the start and the end cell.\n\n### Input\nThe first line contains `n` and `m`. Each of the next `n` lines contains `m` integers: the costs of the cells in that row.\n\n### Output\nPrint a single integer: the minimum total cost.",
    "constraints": [
      "1 \u2264 n, m \u2264 200",
      "0 \u2264 cost \u2264 10\u2074"
    ],
    "samples": [
      {
        "input": "3 3\n1 3 1\n1 5 1\n4 2 1\n",
        "output": "7\n",
        "note": "1 \u2192 3 \u2192 1 \u2192 1 \u2192 1"
      },
      {
        "input": "2 3\n1 2 3\n4 5 6\n",
        "output": "12\n"
      }
    ]
  },
  {
    "id": "C",
    "title": "Bridge Count",
    "difficulty": "Hard",
    "points": 300,
    "timeLimitMs": 2000,
    "statement": "A campus network has `n` routers joined by `m` two-way cables. A cable is **critical** if removing it disconnects two routers that were previously connected.\n\nCount the critical cables.\n\n### Input\nThe first line contains `n` and `m`. Each of the next `m` lines contains two integers `u` and `v`: a cable between routers `u` and `v`.\n\n### Output\nPrint a single integer: the number of critical cables.\n\n> The network is not necessarily connected. Recursion depth is limited inside the browser \u2014 an iterative DFS is the safe choice in Python.",
    "constraints": [
      "2 \u2264 n \u2264 3000",
      "1 \u2264 m \u2264 6000",
      "1 \u2264 u, v \u2264 n, u \u2260 v",
      "No duplicate cables"
    ],
    "samples": [
      {
        "input": "5 5\n1 2\n1 3\n2 3\n3 4\n4 5\n",
        "output": "2\n",
        "note": "Cables 3\u20134 and 4\u20135 are critical."
      },
      {
        "input": "4 4\n1 2\n2 3\n3 4\n4 1\n",
        "output": "0\n"
      }
    ]
  }
];

/** Starter code. Every template reads stdin and writes stdout. */
export const LANGUAGES = {
  py: {
    label: 'Python 3', file: 'main.py', monaco: 'python',
    template: t => `import sys


def main():
    data = sys.stdin.read().split()
    # TODO: solve "${t}"


if __name__ == "__main__":
    main()
`
  },
  cpp: {
    label: 'C++17', file: 'main.cpp', monaco: 'cpp',
    template: t => `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    // TODO: solve "${t}"

    return 0;
}
`
  },
  c: {
    label: 'C (C17)', file: 'main.c', monaco: 'c',
    template: t => `#include <stdio.h>

int main(void) {
    // TODO: solve "${t}"
    // Read from stdin, print the answer to stdout.

    return 0;
}
`
  },
  java: {
    label: 'Java 21', file: 'Main.java', monaco: 'java',
    template: t => `import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
        // TODO: solve "${t}"
    }
}
`
  }
};

/** JSCPP (the light C/C++ engine) understands neither <bits/stdc++.h> nor the STL. */
export const JSCPP_TEMPLATES = {
  cpp: t => `#include <iostream>
using namespace std;

int main() {
    // TODO: solve "${t}"
    return 0;
}
`
};
