#!/bin/bash
#SBATCH -A oconnor_ljo8
#SBATCH -p short
#SBATCH -c 16
#SBATCH --mem=24G
#SBATCH -t 6:00:00
#SBATCH -o handoff/data/bt/logs/embed-%x-%j.log
export HF_HOME=$PWD/.cache/hf TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=16
EXTRA=""; [ "$1" = specter2 ] && EXTRA="--with adapters"
uv run --no-project --python 3.12 --with torch --with sentence-transformers --with model2vec --with pandas --with pyarrow $EXTRA python dev/backtest/embed.py $1
