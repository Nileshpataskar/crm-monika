import pandas as pd
df=pd.read_excel("data/po_summary.xlsx")
print(df.shape)
print(df.columns.tolist())
print(df.head(10))